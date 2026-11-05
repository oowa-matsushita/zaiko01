import { json } from '../lib.js';

// POST /api/ocr-plate  { image: "data:image/jpeg;base64,..." }
// コーションプレートの写真から 車台番号 と カラーコード を読み取る（Cloudflare Workers AI）
const MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
  '@cf/meta/llama-3.2-11b-vision-instruct',
];

const PROMPT = `これは日本の自動車のコーションプレート（車体番号・カラー等が刻印された金属プレート）の写真です。
次の2つを読み取ってください。
- chassis_no: 車台番号（「車台番号」「CHASSIS NO.」「FRAME NO.」「VIN」の欄）。例: ZVW30-1234567、または17桁のVIN
- color_code: カラーコード（「COLOR」「カラー」「COLOR/TRIM」の欄。"/"の左側だけ）。例: 070、1F7、QAB
読み取れない項目は空文字にしてください。
説明は不要です。次のJSONだけを出力してください:
{"chassis_no":"","color_code":""}`;

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: 'AI が設定されていません（wrangler.toml の [ai] binding）' }, 500);
  let image;
  try {
    ({ image } = await request.json());
  } catch {
    return json({ error: '画像を送ってください' }, 400);
  }
  if (typeof image !== 'string' || !image.startsWith('data:image/')) return json({ error: '画像の形式が正しくありません' }, 400);
  if (image.length > 4_000_000) return json({ error: '画像が大きすぎます' }, 413);

  const errors = [];
  for (const model of MODELS) {
    try {
      const text = await runModel(env.AI, model, image);
      const result = parse(text);
      if (result) return json({ ...result, model });
      errors.push(`${model}: 結果を解析できませんでした`);
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  return json({ error: '読み取りに失敗しました', detail: errors }, 502);
}

async function runModel(ai, model, image) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: image } },
    ],
  }];
  const run = () => ai.run(model, { messages, max_tokens: 200, temperature: 0 });
  let out;
  try {
    out = await run();
  } catch (e) {
    // Llama 3.2 Vision は初回にライセンス同意が必要
    if (/agree/i.test(e.message || '')) {
      await ai.run(model, { prompt: 'agree' });
      out = await run();
    } else throw e;
  }
  const r = out?.response ?? out?.result?.response ?? out;
  return typeof r === 'string' ? r : JSON.stringify(r);
}

// AI の返答から JSON を取り出して整える
export function parse(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const chassis = normChassis(obj.chassis_no ?? obj.chassis ?? '');
  const color = normColor(obj.color_code ?? obj.color ?? '');
  if (!chassis && !color) return { chassis_no: '', color_code: '' };
  return { chassis_no: chassis, color_code: color };
}

function toHalf(s) {
  return String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[ー－―‐]/g, '-');
}
function normChassis(s) {
  return toHalf(s).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
}
function normColor(s) {
  return toHalf(s).toUpperCase().split('/')[0].replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}
