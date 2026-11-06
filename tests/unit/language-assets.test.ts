import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  classOf,
  cjkShare,
  isJapaneseBlock,
  japaneseCharCount,
  classShare,
} from "../../src/lib/gate/charset";

const ASSETS_DIR = path.resolve(import.meta.dirname, "../assets");

describe("test assets existence & integrity", () => {
  const assets = [
    "inpainting-test.png",
    "vertical-japanese-test.png",
    "horizontal-japanese-test.png",
    "korean-test.png",
    "chinese-vertical-test.jpg",
  ];

  for (const asset of assets) {
    it(`verifies ${asset} exists and has valid image headers`, () => {
      const filePath = path.join(ASSETS_DIR, asset);
      expect(fs.existsSync(filePath)).toBe(true);

      const buffer = fs.readFileSync(filePath);
      expect(buffer.length).toBeGreaterThan(1000);

      if (asset.endsWith(".png")) {
        expect(buffer[0]).toBe(0x89);
        expect(buffer[1]).toBe(0x50);
        expect(buffer[2]).toBe(0x4e);
        expect(buffer[3]).toBe(0x47);
      } else if (asset.endsWith(".jpg")) {
        expect(buffer[0]).toBe(0xff);
        expect(buffer[1]).toBe(0xd8);
      }
    });
  }
});

describe("script classification for asset language targets", () => {
  it("classifies Japanese manga text (from vertical-japanese-test.png)", () => {
    const text = "これはあたしとセラの冒険のお話。苦しみと喜びを分かち合いながら旅してる";
    expect(cjkShare(text)).toBeGreaterThan(0.9);
    expect(japaneseCharCount(text)).toBeGreaterThan(10);
    for (const char of "これはあたしとセラの冒険のお話") {
      expect(isJapaneseBlock(char.codePointAt(0)!)).toBe(true);
    }
  });

  it("classifies Japanese horizontal text (from inpainting-test.png)", () => {
    const text = "今日が引退前の最後の日になると思う。あら エドワード… もう店を出ていくの？";
    expect(cjkShare(text)).toBeGreaterThan(0.9);
    expect(japaneseCharCount(text)).toBeGreaterThan(10);
    for (const char of "今日が引退前の最後の日になると思う") {
      expect(isJapaneseBlock(char.codePointAt(0)!)).toBe(true);
    }
  });

  it("classifies Korean manhwa text (from korean-test.png)", () => {
    const text = "저기... 총각 뭐 좀 물어볼게. 코엔지역은 이리로 가면 될까?";
    for (const char of "저기총각뭐좀물어볼게코엔지역은이리로가면될까") {
      expect(classOf(char.codePointAt(0)!)).toBe("hangul");
    }
    expect(classShare(text, ["hangul"])).toBeGreaterThan(0.7);
  });

  it("classifies Chinese manhua text (from chinese-vertical-test.jpg)", () => {
    const text = "各位贵宾，请自由拿取这边的餐点。三越餐厅的新菜单试吃会，现正举办中！";
    for (const char of "各位贵宾请自由拿取这边的餐点三越餐厅的新菜单试吃会现正举办中") {
      expect(classOf(char.codePointAt(0)!)).toBe("han");
    }
    expect(classShare(text, ["han"])).toBeGreaterThan(0.8);
  });
});

