import "dotenv/config";

const adminToken = process.env.ADMIN_TOKEN;

if (!adminToken || adminToken.length < 32) {
  throw new Error("ADMIN_TOKEN must be at least 32 characters");
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  adminToken,
  allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim()),
};
