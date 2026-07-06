import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: "https://echo-r.veritasforge.net",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/echo-r",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/about",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/contact",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/legal",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/terms",
            lastModified: new Date(),
        },
        {
            url: "https://echo-r.veritasforge.net/privacy",
            lastModified: new Date(),
        },
    ];
}