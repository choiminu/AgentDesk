import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3847;

async function orca(...args) {
  const { stdout } = await exec("orca", [...args, "--json"], {
    timeout: 15000,
  });
  return JSON.parse(stdout);
}

const routes = {
  "/api/ps": () => orca("worktree", "ps"),
  "/api/terminals": () => orca("terminal", "list"),
  "/api/worktrees": () => orca("worktree", "list"),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await readFile(join(__dirname, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const handler = routes[url.pathname];
  if (handler) {
    try {
      const data = await handler();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Orca dashboard → http://localhost:${PORT}`);
});
