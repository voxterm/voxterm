import type { VolcanoTtsConfig } from './types';
// Note: We need 'ws' package for custom headers support (Bun's built-in WebSocket doesn't support headers)
import WebSocket from 'ws';

/**
 * Volcano Engine BigModel TTS Provider (WebSocket Bidirectional)
 * Implements the binary protocol for premium voices like wanwanxiaohe
 *
 * Based on xiaozhi-server's huoshan_double_stream.py implementation
 */

// Protocol constants
const PROTOCOL_VERSION = 0b0001;
const DEFAULT_HEADER_SIZE = 0b0001;

// Message Types
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_RESPONSE = 0b1011;
const FULL_SERVER_RESPONSE = 0b1001;
const ERROR_INFORMATION = 0b1111;

// Message Type Specific Flags
const MsgTypeFlagNoSeq = 0b0000;
const MsgTypeFlagWithEvent = 0b0100;

// Serialization
const NO_SERIALIZATION = 0b0000;
const JSON_SERIALIZATION = 0b0001;

// Compression
const COMPRESSION_NO = 0b0000;

// Events
const EVENT_NONE = 0;
const EVENT_StartSession = 100;
const EVENT_FinishSession = 102;
const EVENT_SessionStarted = 150;
const EVENT_SessionFinished = 152;
const EVENT_SessionFailed = 153;
const EVENT_TaskRequest = 200;
const EVENT_TTSSentenceStart = 350;
const EVENT_TTSSentenceEnd = 351;
const EVENT_TTSResponse = 352;

interface BigModelTtsConfig extends VolcanoTtsConfig {
  resourceId?: string;
  speechRate?: number;
  loudnessRate?: number;
  pitch?: number;
}

/**
 * Build binary header for WebSocket messages
 */
function buildHeader(
  messageType: number,
  messageTypeFlags: number = MsgTypeFlagNoSeq,
  serialMethod: number = NO_SERIALIZATION,
  compression: number = COMPRESSION_NO
): Uint8Array {
  return new Uint8Array([
    (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE,
    (messageType << 4) | messageTypeFlags,
    (serialMethod << 4) | compression,
    0, // reserved
  ]);
}

/**
 * Build optional section with event and sessionId
 */
function buildOptional(event: number, sessionId?: string): Uint8Array {
  const parts: number[] = [];

  // Event (4 bytes, big-endian, signed)
  const eventBytes = new DataView(new ArrayBuffer(4));
  eventBytes.setInt32(0, event, false); // big-endian
  parts.push(...new Uint8Array(eventBytes.buffer));

  // SessionId if provided
  if (sessionId) {
    const sessionIdBytes = new TextEncoder().encode(sessionId);
    const sizeBytes = new DataView(new ArrayBuffer(4));
    sizeBytes.setInt32(0, sessionIdBytes.length, false);
    parts.push(...new Uint8Array(sizeBytes.buffer));
    parts.push(...sessionIdBytes);
  }

  return new Uint8Array(parts);
}

/**
 * Build payload with size prefix
 */
function buildPayloadWithSize(payload: object): Uint8Array {
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadStr);

  const sizeBytes = new DataView(new ArrayBuffer(4));
  sizeBytes.setInt32(0, payloadBytes.length, false);

  const result = new Uint8Array(4 + payloadBytes.length);
  result.set(new Uint8Array(sizeBytes.buffer), 0);
  result.set(payloadBytes, 4);

  return result;
}

/**
 * Combine header, optional, and payload into full message
 */
function buildMessage(header: Uint8Array, optional: Uint8Array, payload?: Uint8Array): Uint8Array {
  const totalLength = header.length + optional.length + (payload?.length || 0);
  const result = new Uint8Array(totalLength);

  let offset = 0;
  result.set(header, offset);
  offset += header.length;

  result.set(optional, offset);
  offset += optional.length;

  if (payload) {
    result.set(payload, offset);
  }

  return result;
}

/**
 * Parse response header
 */
function parseHeader(data: Uint8Array): {
  protocolVersion: number;
  headerSize: number;
  messageType: number;
  messageTypeFlags: number;
  serialMethod: number;
  compression: number;
} {
  return {
    protocolVersion: (data[0] >> 4) & 0x0f,
    headerSize: data[0] & 0x0f,
    messageType: (data[1] >> 4) & 0x0f,
    messageTypeFlags: data[1] & 0x0f,
    serialMethod: (data[2] >> 4) & 0x0f,
    compression: data[2] & 0x0f,
  };
}

/**
 * Read 4-byte big-endian signed integer
 */
function readInt32BE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getInt32(0, false);
}

/**
 * Read string with size prefix
 */
function readStringWithSize(data: Uint8Array, offset: number): { value: string; newOffset: number } {
  const size = readInt32BE(data, offset);
  offset += 4;
  const value = new TextDecoder().decode(data.slice(offset, offset + size));
  offset += size;
  return { value, newOffset: offset };
}

/**
 * Read payload with size prefix
 */
function readPayloadWithSize(data: Uint8Array, offset: number): { payload: Uint8Array; newOffset: number } {
  const size = readInt32BE(data, offset);
  offset += 4;
  const payload = data.slice(offset, offset + size);
  offset += size;
  return { payload, newOffset: offset };
}

export class VolcanoBigModelTtsProvider {
  private wsUrl = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
  private resourceId: string;
  private speechRate: number;
  private loudnessRate: number;
  private pitch: number;

  constructor(private config: BigModelTtsConfig) {
    this.resourceId = config.resourceId || 'volc.service_type.10029';
    this.speechRate = config.speechRate || 0;
    this.loudnessRate = config.loudnessRate || 0;
    this.pitch = config.pitch || 0;
  }

  /**
   * Synthesize text to speech using WebSocket bidirectional streaming
   * @returns Buffer containing PCM audio data (16kHz, 16-bit, mono)
   */
  async synthesize(
    text: string,
    options: {
      speaker?: string;
      speechRate?: number;
      loudnessRate?: number;
      pitch?: number;
    } = {}
  ): Promise<Buffer> {
    const speaker = options.speaker || this.config.voice || 'zh_female_wanwanxiaohe_moon_bigtts';
    const speechRate = options.speechRate ?? this.speechRate;
    const loudnessRate = options.loudnessRate ?? this.loudnessRate;
    const pitch = options.pitch ?? this.pitch;

    const sessionId = crypto.randomUUID().replace(/-/g, '');
    const connectId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const audioChunks: Buffer[] = [];
      let sessionStarted = false;
      let textSent = false;

      // Create WebSocket with custom headers using ws package
      const ws = new WebSocket(this.wsUrl, {
        headers: {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.token,
          'X-Api-Resource-Id': this.resourceId,
          'X-Api-Connect-Id': connectId,
        },
      });

      const cleanup = () => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close();
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error('TTS request timed out'));
        }
      }, 30000);

      ws.on('open', () => {
        console.log('WebSocket connected, starting session...');

        // Send StartSession
        const header = buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION);
        const optional = buildOptional(EVENT_StartSession, sessionId);
        const payload = buildPayloadWithSize({
          user: { uid: 'ghaa-user' },
          event: EVENT_StartSession,
          namespace: 'BidirectionalTTS',
          req_params: {
            text: '',
            speaker: speaker,
            audio_params: {
              format: 'pcm',
              sample_rate: 16000,
              speech_rate: speechRate,
              loudness_rate: loudnessRate,
            },
          },
          additions: {
            post_process: {
              pitch: pitch,
            },
          },
        });

        const message = buildMessage(header, optional, payload);
        ws.send(message);
      });

      ws.on('message', (rawData: Buffer) => {
        try {
          const data = new Uint8Array(rawData);
          const header = parseHeader(data);

          let offset = 4; // Skip header

          // Check for event flag
          if (header.messageTypeFlags === MsgTypeFlagWithEvent) {
            const eventType = readInt32BE(data, offset);
            offset += 4;

            if (eventType === EVENT_SessionStarted) {
              console.log('Session started, sending text...');
              sessionStarted = true;

              // Read sessionId and response_meta_json
              const { newOffset: off1 } = readStringWithSize(data, offset);
              offset = off1;
              // Skip response_meta_json if present
              if (offset < data.length) {
                const { newOffset: off2 } = readStringWithSize(data, offset);
                offset = off2;
              }

              // Send text request
              const textHeader = buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION);
              const textOptional = buildOptional(EVENT_TaskRequest, sessionId);
              const textPayload = buildPayloadWithSize({
                user: { uid: 'ghaa-user' },
                event: EVENT_TaskRequest,
                namespace: 'BidirectionalTTS',
                req_params: {
                  text: text,
                  speaker: speaker,
                  audio_params: {
                    format: 'pcm',
                    sample_rate: 16000,
                    speech_rate: speechRate,
                    loudness_rate: loudnessRate,
                  },
                },
                additions: {
                  post_process: {
                    pitch: pitch,
                  },
                },
              });

              const textMessage = buildMessage(textHeader, textOptional, textPayload);
              ws.send(textMessage);
              textSent = true;

              // Send FinishSession immediately after text
              const finishHeader = buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION);
              const finishOptional = buildOptional(EVENT_FinishSession, sessionId);
              const finishPayload = buildPayloadWithSize({});
              const finishMessage = buildMessage(finishHeader, finishOptional, finishPayload);
              ws.send(finishMessage);

            } else if (eventType === EVENT_TTSSentenceStart) {
              // Read sessionId
              const { newOffset: off1 } = readStringWithSize(data, offset);
              offset = off1;
              // Read payload (contains text being synthesized)
              if (offset < data.length) {
                const { payload } = readPayloadWithSize(data, offset);
                const payloadJson = JSON.parse(new TextDecoder().decode(payload));
                console.log(`Synthesizing: "${payloadJson.text || text}"`);
              }

            } else if (eventType === EVENT_TTSResponse && header.messageType === AUDIO_ONLY_RESPONSE) {
              // Read sessionId
              const { newOffset: off1 } = readStringWithSize(data, offset);
              offset = off1;
              // Read audio payload
              const { payload } = readPayloadWithSize(data, offset);
              audioChunks.push(Buffer.from(payload));

            } else if (eventType === EVENT_TTSSentenceEnd) {
              console.log('Sentence synthesis complete');

            } else if (eventType === EVENT_SessionFinished) {
              console.log('Session finished');
              clearTimeout(timeout);
              cleanup();
              const audio = Buffer.concat(audioChunks);
              console.log(`Synthesized ${text.length} chars, ${audio.length} bytes PCM audio`);
              resolve(audio);

            } else if (eventType === EVENT_SessionFailed) {
              // Read sessionId and error info
              const { newOffset: off1 } = readStringWithSize(data, offset);
              offset = off1;
              let errorMsg = 'Session failed';
              if (offset < data.length) {
                const { value } = readStringWithSize(data, offset);
                errorMsg = value;
              }
              console.error('Session failed:', errorMsg);
              clearTimeout(timeout);
              cleanup();
              reject(new Error(errorMsg));
            }
          } else if (header.messageType === ERROR_INFORMATION) {
            const errorCode = readInt32BE(data, offset);
            offset += 4;
            const { payload } = readPayloadWithSize(data, offset);
            const errorMsg = new TextDecoder().decode(payload);
            console.error(`Error ${errorCode}: ${errorMsg}`);
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`TTS error ${errorCode}: ${errorMsg}`));
          }
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      });

      ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error.message);
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`WebSocket error: ${error.message}`));
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        if (audioChunks.length > 0) {
          const audio = Buffer.concat(audioChunks);
          console.log(`Connection closed. Got ${audio.length} bytes audio.`);
          resolve(audio);
        } else if (!sessionStarted) {
          reject(new Error(`WebSocket closed before session started: ${code} ${reason.toString()}`));
        }
      });
    });
  }

  /**
   * Convert PCM to WAV format
   */
  pcmToWav(pcmData: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }
}

export default VolcanoBigModelTtsProvider;
