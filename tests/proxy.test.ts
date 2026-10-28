import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { GitRunner } from "../src/runner.js";
import { fixture, git, request } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as { port: number }).port;
};
const cleanEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && !/proxy/i.test(key),
    ),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  no_proxy: "",
  NO_PROXY: "",
});

it.each(["http", "https"])(
  "commits, pushes, and fetches directly over %s despite environment and repository proxies",
  async (protocol) => {
    const f = await fixture();
    cleanup.push(f.remove);
    await git(f.remote, "config", "http.receivepack", "true");
    const paths: string[] = [];
    // A real smart-HTTP Git server, restricted to this disposable fixture.
    const handler: Parameters<typeof createServer>[1] = (req, res) => {
      const url = new URL(req.url!, "http://fixture");
      paths.push(url.pathname);
      const backend = spawn("git", ["http-backend"], {
        env: {
          ...cleanEnv(),
          GIT_PROJECT_ROOT: f.root,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"],
          CONTENT_LENGTH: req.headers["content-length"],
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      backend.stderr.resume();
      const chunks: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      backend.on("close", (code) => {
        const data = Buffer.concat(chunks);
        const boundary = data.indexOf("\r\n\r\n");
        if (code !== 0 || boundary < 0) {
          res.writeHead(500).end();
          return;
        }
        for (const line of data
          .subarray(0, boundary)
          .toString()
          .split("\r\n")) {
          const colon = line.indexOf(":");
          const key = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === "status") res.statusCode = parseInt(value);
          else res.setHeader(key, value);
        }
        res.end(data.subarray(boundary + 4));
      });
      req.pipe(backend.stdin);
    };
    let server: Server;
    if (protocol === "https") {
      const key = join(f.root, "tls-key.pem");
      const cert = join(f.root, "tls-cert.pem");
      await exec("openssl", [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ]);
      server = createTlsServer(
        { key: await readFile(key), cert: await readFile(cert) },
        handler,
      );
      // Test with certificate validation enabled.
      await git(f.repo, "config", "http.sslCAInfo", cert);
    } else server = createServer(handler);
    const url = `${protocol}://127.0.0.1:${await listen(server)}/remote.git`;
    await git(f.repo, "remote", "set-url", "origin", url);

    let proxyHits = 0;
    const proxy = createServer((_req, res) => {
      proxyHits++;
      res.writeHead(502).end("Proxy must not be used");
    });
    proxy.on("connect", (_req, socket) => {
      proxyHits++;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    await git(f.repo, "config", "http.proxy", proxyUrl);
    await git(f.repo, "config", `http.${url}.proxy`, proxyUrl);
    await git(f.repo, "config", "remote.origin.proxy", proxyUrl);
    // Positive control: ordinary Git really attempts the configured proxy.
    await expect(
      exec("git", ["ls-remote", "origin"], {
        cwd: f.repo,
        env: cleanEnv(),
        timeout: 5000,
      }),
    ).rejects.toBeDefined();
    expect(proxyHits).toBeGreaterThan(0);
    proxyHits = 0;
    paths.length = 0;

    // Also prove bypass does not attempt to acquire proxy credentials.
    const authenticatedProxy = proxyUrl.replace("://", "://proxy-user@");
    await git(f.repo, "config", `http.${url}.proxy`, authenticatedProxy);
    await git(f.repo, "config", "remote.origin.proxy", authenticatedProxy);
    // Included keys with '=' cannot safely be passed using -c key=value.
    const unusualKey = `http.${url}/a=b.proxy`;
    const included = join(f.root, "included.config");
    await git(
      f.root,
      "config",
      "--file",
      included,
      unusualKey,
      authenticatedProxy,
    );
    await git(f.repo, "config", "include.path", included);
    const originalConfig = await readFile(join(f.repo, ".git", "config"));
    for (const name of [
      "http_proxy",
      "HTTP_PROXY",
      "https_proxy",
      "HTTPS_PROXY",
      "all_proxy",
      "ALL_PROXY",
      "FtP_PrOxY",
    ])
      vi.stubEnv(name, proxyUrl);
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    const coordinator = await f.open();
    cleanup.push(() => coordinator.close());
    expect(
      await coordinator.repository.git.text(["config", "--get", unusualKey]),
    ).toBe("");
    await writeFile(join(f.repo, "direct.txt"), "Direct connection\n");
    const result = await coordinator.commitAndPush(request("direct"));
    expect(result).toMatchObject({ status: "SUCCEEDED", pushed: true });
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      result.commit_sha,
    );
    await coordinator.repository.fetchRemoteTip(result.commit_sha as string);
    const refs = await coordinator.repository.git.text(
      ["ls-remote", "origin"],
      {
        env: { http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" },
      },
    );
    expect(refs).toContain(result.commit_sha);
    expect(paths).toContain("/remote.git/git-receive-pack");
    expect(paths).toContain("/remote.git/git-upload-pack");
    expect(proxyHits).toBe(0);
    expect(await readFile(join(f.repo, ".git", "config"))).toEqual(
      originalConfig,
    );
    expect(process.env.http_proxy).toBe(proxyUrl);
  },
  30000,
);

it("bypasses inherited and host-specific core.gitProxy for native Git transport", async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  // Serve the native protocol using Git's actual upload-pack implementation.
  const server = createTcpServer((socket) => {
    let header = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length < 4) return;
      const length = parseInt(header.subarray(0, 4).toString(), 16);
      if (header.length < length) return;
      socket.off("data", receive);
      const child = spawn("git", ["upload-pack", f.remote], {
        env: {
          ...cleanEnv(),
          GIT_PROTOCOL: header.includes("version=2") ? "version=2" : "",
        },
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      socket.on("error", () => {});
      child.stdout.pipe(socket);
      child.stdin.write(header.subarray(length));
      socket.pipe(child.stdin);
    };
    socket.on("data", receive);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const url = `git://127.0.0.1:${(server.address() as { port: number }).port}/remote.git`;
  const marker = join(f.root, "proxy-used");
  const proxy = join(f.root, "proxy");
  await writeFile(proxy, '#!/bin/sh\ntouch "$TXD_PROXY_MARKER"\nexit 1\n', {
    mode: 0o755,
  });
  await git(
    f.repo,
    "config",
    "--add",
    "core.gitProxy",
    `${proxy} for 127.0.0.1`,
  );
  await git(f.repo, "config", "--add", "core.gitProxy", proxy);
  await expect(
    exec("git", ["ls-remote", url], {
      cwd: f.repo,
      env: { ...cleanEnv(), TXD_PROXY_MARKER: marker },
      timeout: 5000,
    }),
  ).rejects.toBeDefined();
  expect(await readFile(marker, "utf8")).toBe("");
  await rm(marker);
  vi.stubEnv("GIT_PROXY_COMMAND", proxy);
  const refs = await new GitRunner(f.repo, 5000).text(["ls-remote", url], {
    env: { GIT_PROXY_COMMAND: proxy, TXD_PROXY_MARKER: marker },
  });
  expect(refs).toContain(f.base);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["ProxyCommand", "ProxyJump"])(
  "overrides SSH %s and existing multiplexed connections while retaining identity and host checks",
  async (setting) => {
    const f = await fixture();
    cleanup.push(f.remove);
    const realSsh = (await exec("which", ["ssh"])).stdout.trim();
    const sshConfig = join(f.root, "ssh-config");
    const identity = join(f.root, "identity");
    await writeFile(
      sshConfig,
      `Host fixture-host\n  ${setting} proxy.invalid\n  ControlMaster auto\n  ControlPath ${f.root}/socket\n  IdentityFile ${identity}\n  StrictHostKeyChecking yes\n`,
    );
    const control = (
      await exec(realSsh, ["-G", "-F", sshConfig, "fixture-host"])
    ).stdout;
    expect(control).toContain(`${setting.toLowerCase()} proxy.invalid`);
    const output = join(f.root, "effective-ssh");
    const marker = join(f.root, "proxy-used");
    const proxy = join(f.root, "proxy");
    await writeFile(proxy, '#!/bin/sh\ntouch "$TXD_PROXY_MARKER"\nexit 1\n', {
      mode: 0o755,
    });
    await git(f.repo, "config", "core.sshCommand", proxy);
    // Git invokes this SSH harness. Evaluate its real argv with OpenSSH and
    // exchange real Git packets locally; no SSH authentication is simulated.
    await writeFile(
      join(f.root, "ssh"),
      `#!/usr/bin/env node
const { execFileSync, spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TXD_SSH_OUTPUT, execFileSync(process.env.TXD_REAL_SSH,
  ['-G', '-F', process.env.TXD_SSH_CONFIG, ...process.argv.slice(2)]));
const child = spawn('git', ['upload-pack', process.env.TXD_REMOTE], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`,
      { mode: 0o755 },
    );
    vi.stubEnv("GIT_SSH_COMMAND", proxy);
    vi.stubEnv("GIT_SSH", proxy);
    const refs = await new GitRunner(f.repo, 5000).text(
      ["ls-remote", "fixture-host:remote.git"],
      {
        env: {
          PATH: `${f.root}:${process.env.PATH}`,
          GIT_SSH_COMMAND: proxy,
          GIT_SSH_VARIANT: "simple",
          TXD_SSH_OUTPUT: output,
          TXD_REAL_SSH: realSsh,
          TXD_SSH_CONFIG: sshConfig,
          TXD_REMOTE: f.remote,
          TXD_PROXY_MARKER: marker,
        },
      },
    );
    expect(refs).toContain(f.base);
    const effective = await readFile(output, "utf8");
    expect(effective).not.toMatch(/^proxy(command|jump) (?!none$)/m);
    expect(effective).toContain("controlmaster false");
    expect(effective).not.toMatch(/^controlpath (?!none$)/m);
    expect(effective).toContain(`identityfile ${identity}`);
    expect(effective).toContain("stricthostkeychecking true");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
