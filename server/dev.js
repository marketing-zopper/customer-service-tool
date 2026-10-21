// Local API server. Production uses api/[...route].js on Vercel; both call the same router.
import 'dotenv/config';
import { createServer } from 'node:http';
import { handle } from './router.js';

const port = Number(process.env.API_PORT || 8787);

createServer(handle).listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
