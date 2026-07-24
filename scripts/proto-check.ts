/**
 * Fails if `src/proto/agent_pb.ts` is not what `proto/agent.proto` generates.
 *
 * Runs in `npm run check`, so a hand-edit of the generated file — or a forgotten
 * `npm run proto:gen` after a schema change — is caught in CI rather than at
 * runtime against Cursor's servers.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATED = "src/proto/agent_pb.ts";

const outDir = mkdtempSync(join(tmpdir(), "pi-cursor-proto-"));
try {
  const template = JSON.stringify({
    version: "v2",
    plugins: [{ local: "protoc-gen-es", out: outDir, opt: ["target=ts"] }],
  });

  execFileSync("buf", ["generate", "--template", template, "proto"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH}` },
  });

  const expected = readFileSync(join(outDir, "agent_pb.ts"), "utf8");
  const actual = readFileSync(GENERATED, "utf8");

  if (expected !== actual) {
    console.error(
      `proto:check: ${GENERATED} is out of date with proto/agent.proto.\n` +
        "Run `npm run proto:gen` and commit the result.\n" +
        "If you instead have a newer generated file from upstream, run `npm run proto:sync`.",
    );
    process.exit(1);
  }

  console.log(`proto:check: ok (${GENERATED} matches proto/agent.proto)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
