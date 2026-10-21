// The only module that imports pixi.js. Its unsafe-eval module comes first: despite the name it
// replaces the shader and uniform code Pixi would otherwise compile with `new Function()`, so the
// site's `script-src 'self'` stands with no eval (design §11, §21). The scene imports Pixi from
// here, and only SceneHost imports the scene, lazily, so pages without a table never load it.
import "pixi.js/unsafe-eval";
import { loadTextures } from "pixi.js";

// Assets is never used, so no loader runs; this keeps one from ever making a worker from a blob:
// address, which the CSP refuses anyway.
if (loadTextures.config) loadTextures.config.preferWorkers = false;

export {
  Application,
  BitmapFont,
  BitmapText,
  CanvasSource,
  Container,
  Graphics,
  ImageSource,
  MeshRope,
  NineSliceSprite,
  PerspectiveMesh,
  Point,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
export type { Renderer, TextStyleOptions } from "pixi.js";
