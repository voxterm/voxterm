#!/usr/bin/env python3
"""
Volcano Engine Bidirectional ASR CLI for GHAA
Real-time speech recognition via WebSocket
Based on: https://github.com/zhouruhui/volcengine-asr-ha
"""
import argparse
import asyncio
import gzip
import json
import struct
import sys
import uuid

import websockets


def construct_full_client_request(payload: dict) -> bytes:
    """Construct full client request with binary header"""
    payload_json_bytes = json.dumps(payload).encode("utf-8")
    # Compress with gzip
    payload_gzip = gzip.compress(payload_json_bytes)

    # Header: version=1, msg_type=1 (FullClientRequest), serialization=1 (JSON), compression=1 (gzip)
    header = struct.pack(">BBBB", 0x11, 0x10, 0x11, 0x00)
    size = struct.pack(">I", len(payload_gzip))

    return header + size + payload_gzip


def construct_audio_only_request(audio_data: bytes, is_last: bool = False) -> bytes:
    """Construct audio-only request with binary header"""
    # msg_type = 0b0010 (AudioOnlyClient)
    # flags: 0b0000 = non-final, 0b0010 = final
    flags = 0b0010 if is_last else 0b0000
    msg_type_flags = (0b0010 << 4) | flags

    header = struct.pack(">BBBB", 0x11, msg_type_flags, 0x00, 0x00)
    size = struct.pack(">I", len(audio_data))

    return header + size + audio_data


def parse_response(data: bytes) -> dict:
    """Parse server response"""
    if len(data) < 12:
        return {"error": "Response too short"}

    # Parse header (bytes 0-3)
    header = struct.unpack(">BBBB", data[:4])
    msg_type = (header[1] >> 4) & 0x0F
    compression = header[2] & 0x0F

    # Bytes 4-7: Sequence number
    sequence = struct.unpack(">I", data[4:8])[0]

    # Bytes 8-11: Payload size
    payload_size = struct.unpack(">I", data[8:12])[0]

    # Bytes 12+: Payload
    payload = data[12:12+payload_size]

    # Decompress if gzip
    if compression == 1:
        try:
            payload = gzip.decompress(payload)
        except:
            pass

    # Parse JSON
    payload_str = payload.decode("utf-8", errors="ignore")
    try:
        result = json.loads(payload_str)
        result["_msg_type"] = msg_type
        result["_sequence"] = sequence
        return result
    except json.JSONDecodeError:
        return {"_msg_type": msg_type, "_sequence": sequence, "raw": payload_str}


async def recognize(
    appid: str,
    access_token: str,
    resource_id: str,
    audio_file: str,
    audio_format: str = "pcm",
    sample_rate: int = 16000,
) -> str:
    """Recognize speech from audio file and return text"""

    endpoint = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"

    headers = {
        "X-Api-App-Key": appid,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }

    print(f"Connecting to {endpoint}...", file=sys.stderr)
    websocket = await websockets.connect(
        endpoint, additional_headers=headers, max_size=10 * 1024 * 1024
    )

    all_text = []

    try:
        # Send initial request
        init_payload = {
            "user": {"uid": str(uuid.uuid4())},
            "audio": {
                "format": audio_format,
                "rate": sample_rate,
                "bits": 16,
                "channel": 1,
                "codec": "raw",
            },
            "request": {
                "model_name": "bigmodel",
                "language": "zh",
                "enable_itn": True,
                "enable_punc": True,
                "result_type": "full",
                "show_utterances": True,
            },
        }

        init_msg = construct_full_client_request(init_payload)
        await websocket.send(init_msg)
        print("Initial request sent", file=sys.stderr)

        # Read audio file
        with open(audio_file, "rb") as f:
            audio_data = f.read()
        print(f"Audio file size: {len(audio_data)} bytes", file=sys.stderr)

        # Send audio in chunks
        chunk_size = 16000  # Send larger chunks for pre-recorded audio
        total_sent = 0

        async def send_audio():
            nonlocal total_sent
            for i in range(0, len(audio_data), chunk_size):
                chunk = audio_data[i:i + chunk_size]
                is_last = (i + chunk_size) >= len(audio_data)
                msg = construct_audio_only_request(chunk, is_last)
                await websocket.send(msg)
                total_sent += len(chunk)
            print(f"Sent {total_sent} bytes of audio", file=sys.stderr)

        # Start sending in background
        send_task = asyncio.create_task(send_audio())

        # Receive responses
        final_text = ""
        while True:
            try:
                data = await asyncio.wait_for(websocket.recv(), timeout=10.0)
                if isinstance(data, bytes):
                    result = parse_response(data)
                    msg_type = result.get("_msg_type", 0)

                    # msg_type 15 (0b1111) = error
                    if msg_type == 15:
                        print(f"Server error: {result}", file=sys.stderr)
                        break

                    # msg_type 9 (0b1001) = ASR result
                    if msg_type == 9:
                        # Extract text from result
                        if "result" in result:
                            res = result["result"]
                            if isinstance(res, dict):
                                text = res.get("text", "").strip()
                                if text:
                                    final_text = text
                                    # Check if this is definite (final) result
                                    utterances = res.get("utterances", [])
                                    if utterances and utterances[0].get("definite"):
                                        print(f"Final: {text}", file=sys.stderr)
                                        break
                                    else:
                                        print(f"Partial: {text}", file=sys.stderr)

            except asyncio.TimeoutError:
                print("Timeout", file=sys.stderr)
                break
            except websockets.exceptions.ConnectionClosed:
                break

        all_text = [final_text] if final_text else []

        await send_task

    finally:
        await websocket.close()

    return " ".join(all_text)


async def main():
    parser = argparse.ArgumentParser(description="Volcano ASR CLI")
    parser.add_argument("--appid", required=True, help="APP ID")
    parser.add_argument("--token", required=True, help="Access Token")
    parser.add_argument("--resource-id", default="volc.bigasr.sauc.duration", help="Resource ID")
    parser.add_argument("--audio", required=True, help="Audio file path (PCM)")
    parser.add_argument("--format", default="pcm", help="Audio format")
    parser.add_argument("--sample-rate", type=int, default=16000, help="Sample rate")

    args = parser.parse_args()

    try:
        text = await recognize(
            appid=args.appid,
            access_token=args.token,
            resource_id=args.resource_id,
            audio_file=args.audio,
            audio_format=args.format,
            sample_rate=args.sample_rate,
        )
        print(f"RESULT:{text}")
    except Exception as e:
        print(f"ERROR:{e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
