import dotenv from "dotenv";
dotenv.config();

export function port(): number {
  return parseInt(process.env.PORT!, 10) || 8222;
}

export function connString(): string {
  return `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`!;
}

export function privateKey(): string {
  return process.env.PRIVKEY!;
}

export function fundingAddress(): string {
  return process.env.FUNDING_ADDRESS!;
}

export function fundingWif(): string {
  return process.env.FUNDING_WIF!;
}
