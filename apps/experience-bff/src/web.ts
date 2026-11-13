import type { FastifyInstance } from "fastify";
import { webAsset } from "@ehf/web-static";

export function registerWeb(app: FastifyInstance, webRoot: string) {
  app.get("/*", async (request, reply) => {
    const asset = await webAsset(webRoot, request.url);
    if (!asset) return reply.code(404).send({ error: "route.not_found" });
    return reply.type(asset.type).header("cache-control", asset.html ? "no-store" : "public, max-age=31536000, immutable").header("x-content-type-options", "nosniff").header("x-frame-options", "DENY").header("referrer-policy", "no-referrer").send(asset.content);
  });
}
