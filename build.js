const { build } = require("esbuild");
const fs = require("fs");
const path = require("path");

const functionsDir = path.join(__dirname, "src", "functions");
const outDir = path.join(__dirname, "dist");

// Get all subdirectories in src/functions/ (e.g. authorizer, read-service, ...)
const directories = fs.readdirSync(functionsDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

async function bundle() {
  console.log("🛠️  Bắt đầu build các Lambda functions...");

  for (const dir of directories) {
    const entryPoint = path.join(functionsDir, dir, "handler.ts");
    const outPath = path.join(outDir, dir, "index.js");

    if (fs.existsSync(entryPoint)) {
      await build({
        entryPoints: [entryPoint],
        bundle: true,
        minify: true,
        platform: "node",
        target: "node20",
        outfile: outPath,
        // Loại bỏ các module có sẵn trên môi trường AWS Lambda Node.js 20
        external: ["@aws-sdk/*"], 
      });
      console.log(`✅ Đã build xong: ${dir}`);
    }
  }
  
  console.log("🎉 Hoàn tất! Tất cả mã nguồn đã sẵn sàng trong thư mục dist/");
  console.log("Gợi ý: Cấu hình Terraform archive_file trỏ vào từng thư mục con trong dist/ để ZIP.");
}

bundle().catch((err) => {
  console.error("Lỗi khi build:", err);
  process.exit(1);
});
