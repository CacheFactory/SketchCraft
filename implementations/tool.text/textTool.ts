// @archigraph tool.text
// Text tool: click to place a 3D text label. Uses Three.js Sprite with CanvasTexture.

import type { Vec3 } from '../../src/core/types';
import type { ToolMouseEvent, ToolKeyEvent, ToolPreview } from '../../src/core/interfaces';
import { vec3 } from '../../src/core/math';
import { BaseTool } from '../tool.select/BaseTool';
import * as THREE from 'three';

export class TextTool extends BaseTool {
  readonly id = 'tool.text';
  readonly name = 'Text';
  readonly icon = 'type';
  readonly shortcut = 'Shift+T';
  readonly category = 'construct' as const;
  readonly cursor = 'text';

  private placementPoint: Vec3 | null = null;
  private currentPoint: Vec3 | null = null;

  activate(): void {
    super.activate();
    this.reset();
    this.setStatus('Click to place text label position.');
  }

  deactivate(): void {
    this.reset();
    super.deactivate();
  }

  onMouseDown(event: ToolMouseEvent): void {
    if (event.button !== 0) return;
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (!point) return;

    this.placementPoint = point;
    this.setPhase('active');
    this.setStatus('Type text in VCB and press Enter.');
  }

  onMouseMove(event: ToolMouseEvent): void {
    const point = this.getStandardDrawPoint(event) ?? this.resolvePoint(event);
    if (point) this.currentPoint = point;
  }

  onKeyDown(event: ToolKeyEvent): void {
    if (event.key === 'Escape') {
      this.reset();
      this.setStatus('Click to place text label position.');
    }
  }

  onVCBInput(value: string): void {
    if (!this.placementPoint || !value.trim()) return;

    const text = value.trim();

    // Create a Three.js Sprite with the text rendered on a canvas
    this.createTextSprite(text, this.placementPoint);

    this.setStatus(`Label "${text}" placed.`);
    this.reset();
  }

  getVCBLabel(): string {
    return this.phase === 'active' ? 'Text' : '';
  }

  getPreview(): ToolPreview | null {
    if (this.currentPoint && this.phase === 'idle') {
      // Show a small marker where text will be placed
      return null; // The snap marker already shows this
    }
    return null;
  }

  private reset(): void {
    this.placementPoint = null;
    this.currentPoint = null;
    this.setPhase('idle');
    this.setVCBValue('');
  }

  /**
   * Create a Three.js Sprite at the given 3D position with text rendered via Canvas.
   */
  private createTextSprite(text: string, position: Vec3): void {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Measure text and size canvas
    const fontSize = 48;
    const padding = 16;
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;

    canvas.width = textWidth + padding * 2;
    canvas.height = fontSize + padding * 2;

    // Draw background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    const r = 8;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, r);
    ctx.fill();

    // Draw border
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw text
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillStyle = '#333333';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      sizeAttenuation: true,
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(position.x, position.y + 0.3, position.z); // Offset slightly above
    sprite.scale.set(canvas.width / 200, canvas.height / 200, 1); // Scale to reasonable world size

    sprite.name = `text-label-${Date.now()}`;
    sprite.raycast = () => {}; // Non-raycastable

    // Add to overlay scene
    const overlayScene = (this.viewport.renderer as any).getOverlayScene?.();
    if (overlayScene) {
      overlayScene.add(sprite);
    } else {
      // Fallback: add to main scene
      const scene = (this.viewport.renderer as any).getScene?.();
      if (scene) scene.add(sprite);
    }
  }
}
