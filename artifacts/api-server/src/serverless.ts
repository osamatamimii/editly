/**
 * Vercel serverless entrypoint.
 *
 * The Express app itself is a `(req, res) => void` handler, which is exactly
 * what the Vercel Node.js runtime expects as a default export.
 */
import app from "./app";

export default app;
