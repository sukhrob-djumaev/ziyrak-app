import OpenAI from "openai";

/**
 * PLAN.md §19.2/§46.5 — pure, tenant-agnostic Twilio/Whisper/ElevenLabs
 * helpers. Business/tenant-aware call orchestration (customer/conversation
 * resolution, `ChannelConnection` lookup, dedup) moved to
 * `phone-adapter.ts`'s `PhoneAdapter` — this file has no `TenantContext`,
 * no Prisma import, and no `ai/engine.ts` dependency, matching the same
 * split every other migrated channel got.
 *
 * `transcribeAudio`/`synthesizeSpeech`/`generateTwiMLStream` are unused by
 * the live call flow (Twilio's own `<Gather input="speech">`/`<Say>`
 * already provide ASR/TTS) — true before this phase too, and not a Phase 5
 * concern to wire up or remove (§2.4-style dead code, out of this phase's
 * named scope).
 */

// Speech-to-Text using OpenAI Whisper
export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey });

  const file = new File([new Uint8Array(audioBuffer)], "audio.wav", { type: "audio/wav" });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });

  return transcription.text;
}

// Text-to-Speech using ElevenLabs
export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string
): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Generate TwiML response for incoming calls
export function generateTwiMLGather(
  message: string,
  callbackUrl: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(message)}</Say>
  <Gather input="speech" action="${callbackUrl}" method="POST" speechTimeout="auto" language="auto">
    <Say voice="alice">I'm listening.</Say>
  </Gather>
  <Say voice="alice">I didn't hear anything. Goodbye.</Say>
</Response>`;
}

export function generateTwiMLSay(message: string, gatherCallbackUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(message)}</Say>
  <Gather input="speech" action="${escapeXml(gatherCallbackUrl)}" method="POST" speechTimeout="auto" language="auto">
    <Say voice="alice">Is there anything else I can help with?</Say>
  </Gather>
  <Say voice="alice">Thank you for calling. Goodbye.</Say>
</Response>`;
}

export function generateTwiMLStream(websocketUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${websocketUrl}" />
  </Connect>
</Response>`;
}
