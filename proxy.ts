import { NextResponse, type NextRequest } from "next/server";

const TRACKING_PARAMS = [
    "ref",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
];

export function proxy(request: NextRequest) {
    const url = request.nextUrl.clone();
    let changed = false;

    for (const param of TRACKING_PARAMS) {
        if (url.searchParams.has(param)) {
            url.searchParams.delete(param);
            changed = true;
        }
    }

    if (changed) {
        return NextResponse.redirect(url, 308);
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|og-image.png|robots.txt|sitemap.xml).*)",
    ],
};