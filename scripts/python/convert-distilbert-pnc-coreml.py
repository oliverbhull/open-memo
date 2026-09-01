#!/usr/bin/env python3
"""Convert NVIDIA's English DistilBERT PnC checkpoint to quantized Core ML."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import coremltools as ct
import torch
from transformers import DistilBertConfig, DistilBertModel


MAX_TOKENS = 128


class PunctuationCapitalization(torch.nn.Module):
    def __init__(self, state: dict[str, torch.Tensor]) -> None:
        super().__init__()
        self.bert_model = DistilBertModel(DistilBertConfig())
        self.punct_classifier = torch.nn.Linear(768, 4)
        self.capit_classifier = torch.nn.Linear(768, 2)

        mapped: dict[str, torch.Tensor] = {}
        for name, value in state.items():
            if name.startswith("punct_classifier.mlp.layer0."):
                mapped[name.replace("punct_classifier.mlp.layer0.", "punct_classifier.")] = value
            elif name.startswith("capit_classifier.mlp.layer0."):
                mapped[name.replace("capit_classifier.mlp.layer0.", "capit_classifier.")] = value
            else:
                mapped[name] = value
        self.load_state_dict(mapped, strict=True)
        self.eval()

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        embeddings = self.bert_model.embeddings(
            input_ids=input_ids,
            position_ids=self.bert_model.embeddings.position_ids[:, :MAX_TOKENS],
        )
        additive_mask = (1.0 - attention_mask.to(dtype=embeddings.dtype))[:, None, None, :] * -10_000.0
        hidden = self.bert_model.transformer(
            hidden_states=embeddings,
            attention_mask=additive_mask,
        ).last_hidden_state
        return self.punct_classifier(hidden), self.capit_classifier(hidden)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    state = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = PunctuationCapitalization(state)
    example_ids = torch.zeros((1, MAX_TOKENS), dtype=torch.int32)
    example_mask = torch.ones((1, MAX_TOKENS), dtype=torch.int32)
    traced = torch.jit.trace(model, (example_ids, example_mask), strict=True)

    converted = ct.convert(
        traced,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_precision=ct.precision.FLOAT16,
        inputs=[
            ct.TensorType(name="input_ids", shape=example_ids.shape, dtype=int),
            ct.TensorType(name="attention_mask", shape=example_mask.shape, dtype=int),
        ],
        outputs=[
            ct.TensorType(name="punctuation_logits"),
            ct.TensorType(name="capitalization_logits"),
        ],
    )
    config = ct.optimize.coreml.OptimizationConfig(
        global_config=ct.optimize.coreml.OpLinearQuantizerConfig(mode="linear_symmetric", dtype="int8")
    )
    quantized = ct.optimize.coreml.linear_quantize_weights(converted, config=config)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    quantized.save(args.output)

    manifest = {
        "architecture": "distilbert-punctuation-capitalization",
        "max_tokens": MAX_TOKENS,
        "punctuation_labels": ["", ",", ".", "?"],
        "capitalization_labels": ["unchanged", "uppercase-first"],
        "quantization": "int8-linear-symmetric",
    }
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
