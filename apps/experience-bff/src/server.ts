import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4200);
const app = buildApp({ logger: true });
app.listen({ host: process.env.HOST ?? "127.0.0.1", port }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
