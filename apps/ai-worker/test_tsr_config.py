"""Tests for the OmegaConf stand-in the vendored TripoSR tree relies on (KAN-66).

`resolve` is exercised on the exact reference shape config.yaml uses — `${tokenizer.num_channels}` —
because the first version of this module resolved only the last path segment and the reconstruction
stage failed on the cluster with KeyError before any weight was loaded.
"""

import unittest

from tsr_config import Config, OmegaConf


class Resolve(unittest.TestCase):
    def test_dotted_reference_resolves_through_the_whole_path(self):
        cfg = Config({"tokenizer": {"num_channels": 1024},
                      "backbone": {"in_channels": "${tokenizer.num_channels}", "num_layers": 16}})

        resolved = OmegaConf.resolve(cfg)

        self.assertEqual(resolved["backbone"]["in_channels"], 1024)
        self.assertEqual(resolved.backbone.num_layers, 16)

    def test_reference_to_a_top_level_key_still_works(self):
        cfg = Config({"cond_image_size": 512, "image_tokenizer": {"size": "${cond_image_size}"}})

        self.assertEqual(OmegaConf.resolve(cfg).image_tokenizer.size, 512)

    def test_plain_values_are_untouched(self):
        cfg = Config({"renderer": {"density_bias": -1.0, "feature_reduction": "concat"}})

        self.assertEqual(OmegaConf.resolve(cfg).renderer.feature_reduction, "concat")


class Merge(unittest.TestCase):
    def test_unknown_key_is_rejected_rather_than_ignored(self):
        from tsr_config import Schema

        with self.assertRaises(ValueError) as caught:
            OmegaConf.merge(Schema({"plane_size": 32}), {"plane_size": 32, "plane_sizes": 8})
        self.assertIn("CONFIG_UNKNOWN_FIELD", str(caught.exception))

    def test_declared_defaults_survive_when_the_file_omits_them(self):
        import dataclasses
        from tsr_config import Schema

        @dataclasses.dataclass
        class Tokenizer:
            plane_size: int
            num_channels: int = 1024

        merged = OmegaConf.merge(Schema({"plane_size": 32, "num_channels": 1024}), {"plane_size": 64})
        self.assertEqual(merged.plane_size, 64)
        self.assertEqual(OmegaConf.merge(Tokenizer, {"plane_size": 64}).num_channels, 1024)

    def test_field_without_default_must_be_supplied(self):
        import dataclasses
        from tsr_config import REQUIRED

        @dataclasses.dataclass
        class Renderer:
            radius: float
            chunk_size: float = 8192.0

        self.assertEqual(OmegaConf.structured(Renderer).fields["radius"], REQUIRED)
        with self.assertRaises(ValueError) as caught:
            OmegaConf.merge(OmegaConf.structured(Renderer), {"chunk_size": 4096.0})
        self.assertIn("CONFIG_MISSING_FIELD", str(caught.exception))
        self.assertEqual(OmegaConf.merge(OmegaConf.structured(Renderer), {"radius": 0.87}).chunk_size, 8192.0)
        self.assertEqual(OmegaConf.merge(OmegaConf.structured(Renderer),
                                         {"radius": 0.87, "chunk_size": 4096.0}).chunk_size, 4096.0)


class Access(unittest.TestCase):
    def test_missing_attribute_raises_instead_of_returning_none(self):
        with self.assertRaises(AttributeError):
            Config({"radius": 0.87}).density_activation


if __name__ == "__main__":
    unittest.main()
