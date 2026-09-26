import handleApiRequest from "../dist/server.js";

/**
 * Vercel Serverless Function entry point for Velura API.
 */
export default async function handler(req, res) {
  return handleApiRequest(req, res);
}
