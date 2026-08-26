import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const routes = new Map([
  ["/", { file: path.join(projectRoot, "demo", "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { file: path.join(projectRoot, "demo", "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: path.join(projectRoot, "demo", "styles.css"), type: "text/css; charset=utf-8" }],
  ["/fixtures/browser-level1.json", {
    file: path.join(projectRoot, "fixtures", "browser-level1.json"),
    type: "application/json; charset=utf-8",
  }],
]);

export function startDemoServer({ host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || host}`).pathname;
    const route = routes.get(pathname);
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    try {
      const body = await readFile(route.file);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": route.type,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${error.message}\n`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const origin = `http://${host}:${address.port}`;
      resolve({
        origin,
        url: `${origin}/`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

async function main() {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex === -1 ? 4179 : Number.parseInt(process.argv[portIndex + 1], 10);
  const running = await startDemoServer({ port });
  process.stdout.write(`${running.url}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
