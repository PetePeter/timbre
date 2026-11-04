"""LoRA fine-tune a small model on eval sft.jsonl (teacher completions from fully passing training calls).

Trains only on each sample's final assistant message. Validation is split by
scenario (whole calls held out), and the adapter with the best validation loss
is kept, to catch overfitting early.

    python eval/train/lora_sft.py --data <sft.jsonl> --out <dir>
"""
import argparse
import hashlib
import json
import math
import random
import time

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = "LiquidAI/LFM3-1.7B"
# Pinned: the model ships its own Python (trust_remote_code); this revision was reviewed.
REVISION = "ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7"


def to_hf(record):
    messages = []
    for m in record["messages"]:
        m = {k: v for k, v in m.items() if v is not None}
        m.setdefault("content", "")
        if m.get("tool_calls"):
            m["tool_calls"] = [{**c, "function": {**c["function"], "arguments": json.loads(c["function"]["arguments"] or "{}")}}
                               for c in m["tool_calls"]]
        messages.append(m)
    tools = [{"type": "function", "function": t} for t in record["tools"]]
    return messages, tools


def encode(tok, record, max_len):
    messages, tools = to_hf(record)
    prompt = tok.apply_chat_template(messages[:-1], tools=tools, add_generation_prompt=True, tokenize=False)
    full = tok.apply_chat_template(messages, tools=tools, tokenize=False)
    if not full.startswith(prompt):
        return None
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    ids = tok(full, add_special_tokens=False)["input_ids"]
    if len(ids) > max_len:
        return None
    labels = [-100] * len(p_ids) + ids[len(p_ids):]
    return torch.tensor(ids), torch.tensor(labels)


def is_val(scenario, fraction):
    return int(hashlib.sha1(scenario.encode()).hexdigest(), 16) % 100 < fraction * 100


def mean_loss(model, data, device):
    model.eval()
    total = 0.0
    with torch.no_grad():
        for ids, labels in data:
            out = model(input_ids=ids[None].to(device), labels=labels[None].to(device))
            total += out.loss.item()
    model.train()
    return total / max(1, len(data))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--max-len", type=int, default=6144)
    ap.add_argument("--val", type=float, default=0.15)
    ap.add_argument("--cpu", action="store_true", help="train on the CPU (ROCm on Windows fails on RDNA3: ROCm/TheRock#5543)")
    args = ap.parse_args()
    random.seed(0)
    torch.manual_seed(0)

    tok = AutoTokenizer.from_pretrained(BASE, revision=REVISION, trust_remote_code=True)
    records = [json.loads(line) for path in args.data for line in open(path, encoding="utf8") if line.strip()]
    train, val, skipped = [], [], 0
    for r in records:
        enc = encode(tok, r, args.max_len)
        if enc is None:
            skipped += 1
            continue
        (val if is_val(r["scenario"], args.val) else train).append(enc)
    print(f"samples: {len(train)} train, {len(val)} val, {skipped} skipped; "
          f"mean {sum(len(i) for i, _ in train) // max(1, len(train))} tokens, "
          f"{sum(int((l != -100).sum()) for _, l in train) // max(1, len(train))} trained")

    # The biggest GPU: on this PC device 0 is the 780M iGPU, which ROCm cannot run.
    device = (f"cuda:{max(range(torch.cuda.device_count()), key=lambda i: torch.cuda.get_device_properties(i).total_memory)}"
              if torch.cuda.is_available() and not args.cpu else "cpu")
    print(f"device: {torch.cuda.get_device_name(device) if device != 'cpu' else 'cpu'}")
    model = AutoModelForCausalLM.from_pretrained(BASE, revision=REVISION, trust_remote_code=True,
                                                 dtype=torch.float32 if device == "cpu" else torch.bfloat16).to(device)
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05,
                                             target_modules="all-linear", task_type="CAUSAL_LM"))
    model.print_trainable_parameters()
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.01)
    steps = math.ceil(len(train) / args.accum) * args.epochs
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * max(0.0, 1 - s / max(1, steps)))

    best = mean_loss(model, val, device)
    print(f"epoch 0 val loss {best:.4f}")
    for epoch in range(1, args.epochs + 1):
        random.shuffle(train)
        running = 0.0
        started = time.time()
        for i, (ids, labels) in enumerate(train, 1):
            loss = model(input_ids=ids[None].to(device), labels=labels[None].to(device)).loss / args.accum
            loss.backward()
            running += loss.item() * args.accum
            if i % args.accum == 0 or i == len(train):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                rate = (time.time() - started) / i
                print(f"  epoch {epoch} sample {i}/{len(train)} loss {running / i:.4f} "
                      f"({rate:.1f} s/sample, epoch eta {rate * (len(train) - i) / 60:.0f} min)", flush=True)
        v = mean_loss(model, val, device)
        print(f"epoch {epoch} train loss {running / len(train):.4f} val loss {v:.4f}")
        if v < best:
            best = v
            model.save_pretrained(f"{args.out}/adapter")
            print("  saved (best so far)")
        else:
            print("  val loss rose: stopping to avoid overfitting")
            break
    print(f"best val loss {best:.4f}; adapter at {args.out}/adapter")


if __name__ == "__main__":
    main()
