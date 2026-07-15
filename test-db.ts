import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is missing in .env");
  }

  console.log("🔄 Đang thử kết nối tới Supabase PostgreSQL...");

  const client = new Client({ connectionString });
  
  try {
    await client.connect();
    const db = drizzle(client);

    const result = await db.execute(sql`SELECT version();`);
    
    console.log("✅ Kết nối thành công!");
    console.log("Chi tiết Server:", result.rows[0].version);
    
    // Test pgvector
    console.log("🔄 Đang kiểm tra extension pgvector...");
    const vectorRes = await db.execute(sql`SELECT * FROM pg_extension WHERE extname = 'vector';`);
    console.log("🔄 Đang tự động cài đặt extension pgvector...");
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
    console.log("✅ Kích hoạt pgvector thành công!");

  } catch (error) {
    console.error("❌ Kết nối thất bại:", error);
  } finally {
    await client.end();
  }
}

main();
