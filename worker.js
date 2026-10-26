// MUSHAHHIH - server AI untuk LUGHAH CENDEKIA (Cloudflare Worker + Gemini API)
// Secret di Cloudflare: GEMINI_API_KEY (wajib)
// Variabel opsional: GEMINI_MODEL (default gemini-flash-latest), ALLOWED_ORIGIN

const MAX_CHARS = 600;
const JENIS_OK = [
  "Ejaan dan penulisan",
  "Harakat",
  "Tata bahasa (nahwu)",
  "Bentuk kata (sharaf)",
  "Terjemahan Arab ke Indonesia",
  "Terjemahan Indonesia ke Arab",
  "Perbaikan susunan kalimat",
];
const KEYS = [
  "A_teks_masukan",
  "B_saran_perbaikan",
  "C_teks_berharakat",
  "D_terjemahan",
  "E_penjelasan_tata_bahasa",
  "F_alasan_perbaikan",
  "G_contoh_tambahan",
];

function reply(status, body, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function buildPrompt(teks, jenis) {
  return (
    "Kamu adalah MUSHAHHIH, asisten koreksi Bahasa Arab untuk pelajar Indonesia tingkat dasar sampai menengah. " +
    "Jenis pemeriksaan: " + jenis + ".\n" +
    "Teks pengguna: " + teks + "\n\n" +
    "Jawab HANYA dengan satu objek JSON (tanpa markdown, tanpa teks lain) dengan kunci persis berikut, semua nilainya string berbahasa Indonesia sederhana:\n" +
    "A_teks_masukan: teks yang dimasukkan, disalin apa adanya.\n" +
    "B_saran_perbaikan: saran perbaikan (jika sudah benar, katakan benar).\n" +
    "C_teks_berharakat: teks dengan harakat (jika tidak dapat dipastikan, tulis: tidak dapat dipastikan).\n" +
    "D_terjemahan: terjemahan.\n" +
    "E_penjelasan_tata_bahasa: penjelasan tata bahasa singkat.\n" +
    "F_alasan_perbaikan: alasan perbaikan.\n" +
    "G_contoh_tambahan: satu atau dua contoh tambahan.\n" +
    "Aturan: jangan mengarang kaidah atau arti. Jika ragu, katakan ragu. Fokus pada jenis pemeriksaan yang dipilih. " +
    "Jika teks tampak berupa ayat Al-Qur'an atau hadis, jangan mengubah teksnya; sebutkan bahwa teks suci harus dicocokkan dengan mushaf atau kitab hadis yang terpercaya. " +
    "Akhiri nilai G_contoh_tambahan dengan satu kalimat bahwa hasil AI perlu dicek guru."
  );
}

function parseModelText(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  try {
    const obj = JSON.parse(clean);
    const out = {};
    KEYS.forEach((k) => {
      if (obj[k] !== undefined && obj[k] !== null) {
        out[k] = typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k]);
      }
    });
    if (Object.keys(out).length) return out;
  } catch (e) {}
  return { E_penjelasan_tata_bahasa: clean || "Tidak ada jawaban dari AI." };
}

async function handleMushahhih(request, env) {
  const origin = env.ALLOWED_ORIGIN || "*";

  if (request.method === "OPTIONS") return reply(204, {}, origin);
  if (request.method !== "POST") return reply(405, { error: "Gunakan POST." }, origin);

  const key = String(env.GEMINI_API_KEY || "").trim();
  if (!key) return reply(500, { error: "GEMINI_API_KEY belum diisi di Cloudflare." }, origin);

  let input;
  try {
    input = await request.json();
  } catch (e) {
    return reply(400, { error: "Format permintaan salah." }, origin);
  }

  const teks = String((input && input.teks) || "").trim();
  const jenis = String((input && input.jenis) || "").trim();
  if (!teks) return reply(400, { error: "Teks kosong." }, origin);
  if (teks.length > MAX_CHARS)
    return reply(400, { error: "Teks terlalu panjang (maks " + MAX_CHARS + " karakter)." }, origin);
  if (!JENIS_OK.includes(jenis)) return reply(400, { error: "Jenis pemeriksaan tidak dikenal." }, origin);

  const model = env.GEMINI_MODEL || "gemini-flash-latest";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(teks, jenis) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });

    if (res.status === 429) return reply(429, { error: "Kuota gratis harian/menit habis. Coba lagi nanti." }, origin);
    if (!res.ok) {
      let detail = "";
      try {
        const eb = await res.json();
        detail = (eb && eb.error && eb.error.message) || "";
      } catch (e) {}
      console.error("Gemini menolak:", res.status, detail);
      // Kode HTTP asli dari Google diteruskan agar mudah didiagnosis:
      // 400 = key tidak valid, 403 = key ditolak/dibatasi, 404 = model tidak ada.
      return reply(res.status, { error: "Layanan AI menolak permintaan (" + res.status + "). " + detail.slice(0, 200) }, origin);
    }

    const data = await res.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");
    return reply(200, parseModelText(text), origin);
  } catch (e) {
    console.error("Gagal memanggil Gemini:", String(e));
    return reply(502, { error: "Tidak dapat menghubungi layanan AI." }, origin);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    // Menerima alamat gaya Netlify (/.netlify/functions/mushahhih) maupun /api/mushahhih
    if (path === "/.netlify/functions/mushahhih" || path === "/api/mushahhih") {
      return handleMushahhih(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
