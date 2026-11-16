import assert from "node:assert/strict";
import test from "node:test";
import { colorKey, colorKeyFromImageUrl, withInferredImageColors } from "./image-color.js";

const gray = "https://cdn/x/dam-vay_dam-yem_pewter-gray_01.png";
const pink = "https://cdn/x/dam-vay_dam-yem_sakura-pink_02.png";

test("infers colours from catalog file names and keeps explicit mappings", () => {
  assert.equal(colorKey("Pewter Gray"), "pewter-gray");
  assert.equal(colorKeyFromImageUrl(pink), "sakura-pink");
  assert.deepEqual(withInferredImageColors([gray, pink], {}, ["Pewter Gray", "Sakura Pink"]), {
    [gray]: "Pewter Gray",
    [pink]: "Sakura Pink",
  });
  assert.deepEqual(withInferredImageColors([gray, pink], { [pink]: "Đen" }, ["Pewter Gray", "Sakura Pink"]), {
    [gray]: "Pewter Gray",
    [pink]: "Đen",
  });
  assert.deepEqual(withInferredImageColors([gray], {}, ["Black"]), {});
});

test("matches abbreviated file-name colours to full variant names", () => {
  const files = ["https://cdn/x/ao_x_beige_01.jpg", "https://cdn/x/ao_x_slat-blue_02.jpg", "https://cdn/x/ao_x_burgundy_04.jpg"];
  assert.deepEqual(withInferredImageColors(files, {}, ["Burgundy Wine", "Slate Blue", "Soft Beige"]), {
    [files[0]]: "Soft Beige",
    [files[1]]: "Slate Blue",
    [files[2]]: "Burgundy Wine",
  });
});
