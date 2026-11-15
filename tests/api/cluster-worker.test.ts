import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ClusterAiWorker } from '../../apps/api/src/ai/cluster-worker.js';

test('a refresh preserves fresh task readiness until its new observation completes, then revokes on denial', async () => {
  const delayed = Promise.withResolvers<Response>();
  let first = true;
  const http: typeof fetch = async () => {
    if (!first) return delayed.promise;
    first = false;
    return Response.json({ schema_version:'velura-worker-v1', ready:false, tasks:{image_quality:true} }, {status:503});
  };
  const worker = new ClusterAiWorker('http://worker.test', 'synthetic-private-worker-key-0000000000', http);
  await worker.refreshReadiness();
  assert.equal(worker.ready('image_quality'),true);
  const refresh = worker.refreshReadiness();
  assert.equal(worker.ready('image_quality'),true);
  delayed.resolve(Response.json({error_code:'WORKER_UNAUTHORIZED'},{status:401}));
  await refresh;
  assert.equal(worker.ready('image_quality'),false);
});

/**
 * A healthy worker that reports the 360° stage, then answers /ai/try-on-3d with the given sheet layout. Rejected
 * layouts get a 1×1 body: bounds are checked from the header before the sheet is downloaded.
 */
async function turntableWorker(layout: { frames: number; columns: number; rows: number; tile: number }, realSheet = true) {
  const requestId = '11111111-2222-4333-8444-555555555555';
  const directory = await mkdtemp(join(tmpdir(), 'velura-turntable-'));
  await writeFile(join(directory, 'job.json'), JSON.stringify({ request_id: requestId, product_id: 'p1', variant_id: 'v1' }));
  await writeFile(join(directory, 'result.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer());
  const [width, height] = realSheet ? [layout.columns * layout.tile, layout.rows * layout.tile] : [1, 1];
  const sheet = await sharp({ create: { width, height, channels: 3, background: '#ddd' } }).png().toBuffer();
  const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const http: typeof fetch = async (input) => {
    if (String(input).endsWith('/health'))
      return Response.json({ ready: true, gpu: true, tasks: { virtual_try_on: true, virtual_try_on_3d: true } });
    return new Response(new Uint8Array(sheet), {
      headers: {
        'content-type': 'image/png',
        'x-ai-binding': base64Json({ schema_version: 'velura-worker-v1', request_id: requestId, task: 'virtual_try_on_3d', product_id: 'p1', variant_id: 'v1', image_id: 'result.png' }),
        'x-ai-result': base64Json({ status: 'success', model: 'triposr-turntable', ...layout }),
      },
    });
  };
  // No readiness observation here: turntable() itself must observe, since the try-on before it can outlast the 30 s
  // readiness window (the second reason the shipped 360° stage never produced frames).
  return { worker: new ClusterAiWorker('http://worker.test', 'synthetic-private-worker-key-0000000000', http), directory };
}

test('the shipped worker turntable (24 frames tiled 6×4 at 256 px) is accepted, not rejected as a bad layout', async () => {
  const { worker, directory } = await turntableWorker({ frames: 24, columns: 6, rows: 4, tile: 256 });
  const stage = await worker.turntable(directory, new AbortController().signal);
  assert.deepEqual({ frames: stage.frames, columns: stage.columns, rows: stage.rows, tile: stage.tile }, { frames: 24, columns: 6, rows: 4, tile: 256 });
});

test('a turntable layout that does not match its frames or exceeds the sheet limit is refused before download', async () => {
  const wrongRows = await turntableWorker({ frames: 24, columns: 4, rows: 4, tile: 64 }, false);
  await assert.rejects(wrongRows.worker.turntable(wrongRows.directory, new AbortController().signal), /AI_WORKER_STAGE_LAYOUT/);
  const oversized = await turntableWorker({ frames: 36, columns: 8, rows: 5, tile: 512 }, false);
  await assert.rejects(oversized.worker.turntable(oversized.directory, new AbortController().signal), /AI_WORKER_STAGE_LAYOUT/);
});
