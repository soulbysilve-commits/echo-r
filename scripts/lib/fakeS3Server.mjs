// A minimal S3-compatible HTTP server for local testing only: just
// enough of PutObject (with If-None-Match: "*" conditional-create
// support), GetObject, and HeadObject for lib/storage.ts's ObjectStore
// interface to run its real code path (including the real
// @aws-sdk/client-s3 request signing/parsing) against something that
// isn't a live cloud bucket. Not a general-purpose S3 mock -- only
// implements what this repo's fulfillment tests actually exercise.

import http from "node:http";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

function keyToFilePath(root, bucket, key) {
  const safe = key.replace(/\.\./g, "");
  const filePath = path.join(root, bucket, safe);
  mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function xmlError(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

export function startFakeS3Server(rootDir) {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    const bucket = segments[0] || "test-bucket";
    const key = decodeURIComponent(segments.slice(1).join("/"));
    const filePath = keyToFilePath(rootDir, bucket, key);

    if (req.method === "HEAD") {
      if (existsSync(filePath)) {
        res.writeHead(200, {});
        res.end();
      } else {
        res.writeHead(404, {});
        res.end();
      }
      return;
    }

    if (req.method === "GET") {
      if (!existsSync(filePath)) {
        const body = xmlError("NoSuchKey", "The specified key does not exist.");
        res.writeHead(404, { "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length });
      res.end(data);
      return;
    }

    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const ifNoneMatch = req.headers["if-none-match"];
        if (ifNoneMatch === "*" && existsSync(filePath)) {
          const body = xmlError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold.");
          res.writeHead(412, { "Content-Type": "application/xml", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        writeFileSync(filePath, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"fake-etag"' });
        res.end();
      });
      return;
    }

    res.writeHead(405, {});
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, endpoint: `http://127.0.0.1:${port}` });
    });
  });
}
