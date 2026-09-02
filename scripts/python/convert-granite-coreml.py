#!/usr/bin/env python3
"""Convert Granite Speech 5.0 TurboCTC to a fixed-window Core ML INT4 model."""
from __future__ import annotations

import argparse
import json
import shutil
import types
from pathlib import Path

import coremltools as ct
import torch
from coremltools.optimize import coreml as cto
from transformers import AutoModelForCTC

FEATURE_FRAMES = 512
FEATURE_WIDTH = 320


class GraniteLogits(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_features):
        return self.model(input_features=input_features).logits.float()


def fixed_attention(self, hidden_states, position_embeddings, attention_mask=None, **kwargs):
    """Conversion-safe equivalent of Granite's fixed 128-frame block attention."""
    del attention_mask, kwargs
    batch, sequence = 1, self._memo_sequence_length
    context, heads, head_dim = 128, 8, 128
    blocks = sequence // context
    shape = (blocks, context, heads, head_dim)
    query = self.q_proj(hidden_states).reshape(shape).transpose(1, 2)
    key = self.k_proj(hidden_states).reshape(shape).transpose(1, 2)
    value = self.v_proj(hidden_states).reshape(shape).transpose(1, 2)
    relative = self.rel_pos_emb(position_embeddings) * self.scaling
    queries = query.permute(2, 0, 1, 3).reshape(context, blocks * heads, head_dim)
    bias = (queries @ relative.transpose(1, 2)).view(context, blocks, heads, context)
    bias = bias.permute(1, 2, 0, 3).contiguous()
    weights = torch.softmax(
        (query @ key.transpose(2, 3)) * self.scaling + bias,
        dim=-1,
        dtype=torch.float32,
    ).to(query.dtype)
    output = (weights @ value).transpose(1, 2).contiguous()
    output = output.reshape(batch, sequence, heads * head_dim)
    return self.o_proj(output), None


def fixed_subsampling(self, hidden_states, attention_mask=None, position_embeddings=None, **kwargs):
    """Replace unsupported torch.unfold with an exactly equivalent fixed reshape."""
    del attention_mask, kwargs
    residual = hidden_states
    hidden_states = residual + 0.5 * self.feed_forward1(self.norm_feed_forward1(hidden_states))
    attention, _ = self.self_attn(
        hidden_states=self.norm_self_att(hidden_states),
        attention_mask=None,
        position_embeddings=position_embeddings,
    )
    hidden_states = hidden_states + attention
    convolution = self.conv(self.norm_conv(hidden_states), attention_mask=None)
    sequence = self.self_attn._memo_sequence_length
    pooled = hidden_states.reshape(1, sequence // 2, 2, 1024).mean(2)
    hidden_states = pooled + convolution[:, : sequence // 2]
    hidden_states = hidden_states + 0.5 * self.feed_forward2(self.norm_feed_forward2(hidden_states))
    return self.norm_out(hidden_states)


def make_conversion_safe(model):
    for index, layer in enumerate(model.encoder.layers):
        sequence = 512 if index == 0 else 256 if index == 1 else 128
        layer.self_attn._memo_sequence_length = sequence
        layer.self_attn.forward = types.MethodType(fixed_attention, layer.self_attn)
        if index < 2:
            layer.forward = types.MethodType(fixed_subsampling, layer)
    return model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()

    source, output = Path(args.source), Path(args.output)
    model = AutoModelForCTC.from_pretrained(source, trust_remote_code=True).eval().float()
    sample = torch.zeros((1, FEATURE_FRAMES, FEATURE_WIDTH), dtype=torch.float32)

    with torch.no_grad():
        reference = model(input_features=sample).logits.float()
    make_conversion_safe(model)
    with torch.no_grad():
        converted_reference = model(input_features=sample).logits.float()
    if not torch.equal(reference.argmax(-1), converted_reference.argmax(-1)):
        raise RuntimeError("conversion-safe Granite graph changed greedy CTC output")

    with torch.no_grad():
        traced = torch.jit.trace(GraniteLogits(model).eval(), sample, strict=False, check_trace=False)
    fp16 = ct.convert(
        traced,
        inputs=[ct.TensorType(name="input_features", shape=sample.shape)],
        outputs=[ct.TensorType(name="logits")],
        minimum_deployment_target=ct.target.macOS15,
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
    )
    config = cto.OptimizationConfig(
        global_config=cto.OpLinearQuantizerConfig(
            mode="linear_symmetric",
            dtype="int4",
            granularity="per_block",
            block_size=32,
            weight_threshold=512,
        )
    )
    quantized = cto.linear_quantize_weights(fp16, config=config)
    int4_operations = str(quantized.get_spec()).count("constexpr_blockwise_shift_scale")
    if int4_operations == 0:
        raise RuntimeError("Core ML output contains no blockwise INT4 weight operations")
    shutil.rmtree(output, ignore_errors=True)
    quantized.save(output)

    size = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    manifest = {
        "model": "ibm-granite/granite-speech-5.0-470m-turboctc",
        "revision": args.revision,
        "quantization": "int4",
        "mode": "linear_symmetric",
        "granularity": "per_block",
        "block_size": 32,
        "minimum_macos": "15.0",
        "feature_frames": FEATURE_FRAMES,
        "feature_width": FEATURE_WIDTH,
        "max_audio_samples": 163840,
        "mlpackage_bytes": size,
        "int4_operations": int4_operations,
        "torch": torch.__version__,
        "coremltools": ct.__version__,
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
