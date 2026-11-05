"""Tests for the checkpoint key remap (KAN-66): transformers 5 moved the ViT parameter paths."""

import unittest

from triposr_state_dict import remap

LEGACY = [
    "image_tokenizer.model.encoder.layer.0.attention.attention.query.weight",
    "image_tokenizer.model.encoder.layer.0.attention.attention.key.bias",
    "image_tokenizer.model.encoder.layer.0.attention.attention.value.weight",
    "image_tokenizer.model.encoder.layer.0.attention.output.dense.weight",
    "image_tokenizer.model.encoder.layer.0.intermediate.dense.bias",
    "image_tokenizer.model.encoder.layer.0.output.dense.weight",
    "image_tokenizer.model.encoder.layer.0.layernorm_before.weight",
    "image_tokenizer.model.encoder.layer.11.layernorm_after.bias",
    "image_tokenizer.model.embeddings.patch_embeddings.projection.weight",
    "backbone.blocks.0.attn.to_qkv.weight",
    "decoder.mlp.0.weight",
]

MODERN = {
    "image_tokenizer.model.layers.0.attention.q_proj.weight",
    "image_tokenizer.model.layers.0.attention.k_proj.bias",
    "image_tokenizer.model.layers.0.attention.v_proj.weight",
    "image_tokenizer.model.layers.0.attention.o_proj.weight",
    "image_tokenizer.model.layers.0.mlp.fc1.bias",
    "image_tokenizer.model.layers.0.mlp.fc2.weight",
    "image_tokenizer.model.layers.0.layernorm_before.weight",
    "image_tokenizer.model.layers.11.layernorm_after.bias",
}


class Remap(unittest.TestCase):
    def setUp(self):
        self.state = {key: index for index, key in enumerate(LEGACY)}

    def test_vit_block_paths_become_the_transformers_five_layout(self):
        mapped = set(remap(self.state))
        self.assertTrue(MODERN.issubset(mapped), sorted(MODERN - mapped))

    def test_every_legacy_encoder_key_disappears(self):
        self.assertFalse([key for key in remap(self.state) if ".encoder.layer." in key])

    def test_values_follow_their_renamed_key(self):
        mapped = remap(self.state)
        self.assertEqual(mapped["image_tokenizer.model.layers.0.attention.q_proj.weight"],
                         self.state["image_tokenizer.model.encoder.layer.0.attention.attention.query.weight"])

    def test_unrelated_modules_pass_through_untouched(self):
        mapped = remap(self.state)
        for key in ("image_tokenizer.model.embeddings.patch_embeddings.projection.weight",
                    "backbone.blocks.0.attn.to_qkv.weight", "decoder.mlp.0.weight"):
            self.assertIn(key, mapped)

    def test_is_inverse_free_and_key_count_is_preserved(self):
        self.assertEqual(len(remap(self.state)), len(LEGACY))


if __name__ == "__main__":
    unittest.main()
