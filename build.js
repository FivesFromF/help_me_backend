const { build } = require("esbuild");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const functionsDir = path.join(__dirname, "src", "functions");
const distDir = path.join(__dirname, "dist");
const lambdaModuleDir = path.join(__dirname, "infra", "modules", "lambda");

const functions = [
  { name: "audit-worker", entry: "audit-worker/handler.ts", zipNames: ["audit_worker.zip"], destDirs: [lambdaModuleDir] },
  { name: "notification-worker", entry: "notification-worker/handler.ts", zipNames: ["notification_worker.zip"], destDirs: [lambdaModuleDir] },
  { name: "post-confirmation", entry: "post-confirmation/handler.ts", zipNames: ["post_confirmation.zip"], destDirs: [lambdaModuleDir] },
];

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function bundle() {
  console.log("🛠️  Bundling TypeScript Lambda functions with esbuild...");

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  for (const fn of functions) {
    const entryPath = path.join(functionsDir, fn.entry);
    const outFnDir = path.join(distDir, fn.name);
    const outJsPath = path.join(outFnDir, "index.js");

    if (fs.existsSync(entryPath)) {
      if (!fs.existsSync(outFnDir)) {
        fs.mkdirSync(outFnDir, { recursive: true });
      }

      await build({
        entryPoints: [entryPath],
        bundle: true,
        minify: true,
        platform: "node",
        target: "node20",
        outfile: outJsPath,
        external: ["@aws-sdk/*", "@prisma/client", ".prisma/client"],
      });

      console.log(`✅ Built JS bundle for: ${fn.name}`);

      // Create ZIP packages for Terraform
      for (let i = 0; i < fn.destDirs.length; i++) {
        const destDir = fn.destDirs[i];
        const zipName = fn.zipNames[i] || `${fn.name.replace(/-/g, "_")}.zip`;
        if (fs.existsSync(destDir)) {
          const destZipPath = path.join(destDir, zipName);
          await zipDirectory(outFnDir, destZipPath);
          console.log(`📦 Packaged: ${destZipPath}`);
        }
      }
    }
  }

  console.log("🎉 Lambda build and packaging complete!");
}

bundle().catch((err) => {
  console.error("❌ Build error:", err);
  process.exit(1);
});
