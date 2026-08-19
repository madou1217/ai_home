/**
 * 现代 AI Agent 运行时与 Harness 架构设计 - 专业级图片与 SVG 图表交互式预览器组件
 * (Professional Interactive Image & SVG Viewer Component with Pan, Zoom, Rotate, and Fullscreen)
 */

class InteractiveImageViewer {
  constructor() {
    this.scale = 1;
    this.minScale = 0.2;
    this.maxScale = 6.0;
    this.translateX = 0;
    this.translateY = 0;
    this.rotateDeg = 0;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.currentSrc = '';
    this.currentTitle = '';
    this.isSvgMode = false;
    this.svgContent = '';

    this.initDOM();
    this.bindEvents();
  }

  initDOM() {
    // 创建全屏容器
    this.modal = document.createElement('div');
    this.modal.id = 'pro-image-viewer-modal';
    this.modal.innerHTML = `
      <div class="iv-backdrop"></div>
      
      <!-- Top Header Bar -->
      <div class="iv-header">
        <div class="iv-title-info">
          <span class="iv-icon">🖼️</span>
          <span class="iv-title" id="iv-image-title">高清图片预览</span>
          <span class="iv-zoom-pill" id="iv-zoom-label">100%</span>
        </div>
        <div class="iv-top-actions">
          <button class="iv-btn" id="iv-download-btn" title="下载原图">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载
          </button>
          <button class="iv-btn iv-close-btn" id="iv-close-btn" title="关闭 (Esc)">✕</button>
        </div>
      </div>

      <!-- Center Viewport -->
      <div class="iv-viewport" id="iv-viewport">
        <div class="iv-transform-layer" id="iv-transform-layer">
          <img id="iv-target-img" alt="Viewer Preview" style="display:none;" draggable="false" />
          <div id="iv-target-svg" style="display:none;"></div>
        </div>
      </div>

      <!-- Bottom Floating Control HUD Toolbar -->
      <div class="iv-toolbar">
        <button class="iv-tool-btn" id="iv-zoom-out" title="缩小 (快捷键: -)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="iv-tool-btn" id="iv-zoom-in" title="放大 (快捷键: +)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <div class="iv-tool-divider"></div>
        <button class="iv-tool-btn" id="iv-zoom-fit" title="自适应屏幕 (快捷键: 0)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
        <button class="iv-tool-btn" id="iv-zoom-100" title="1:1 原始尺寸 (快捷键: 1)">
          1:1
        </button>
        <div class="iv-tool-divider"></div>
        <button class="iv-tool-btn" id="iv-rotate" title="顺时针旋转 90° (快捷键: R)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        </button>
        <button class="iv-tool-btn" id="iv-reset" title="重置全部变换">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
      </div>

      <!-- Bottom Keyboard Hints -->
      <div class="iv-keyboard-hints">
        <span>滚轮: 自由缩放</span>
        <span class="dot">•</span>
        <span>按住左键: 拖拽平移</span>
        <span class="dot">•</span>
        <span>双击: 放大/还原</span>
        <span class="dot">•</span>
        <span>Esc: 退出预览</span>
      </div>
    `;

    document.body.appendChild(this.modal);

    // 获取内部元素引用
    this.viewport = this.modal.querySelector('#iv-viewport');
    this.transformLayer = this.modal.querySelector('#iv-transform-layer');
    this.targetImg = this.modal.querySelector('#iv-target-img');
    this.targetSvg = this.modal.querySelector('#iv-target-svg');
    this.titleLabel = this.modal.querySelector('#iv-image-title');
    this.zoomLabel = this.modal.querySelector('#iv-zoom-label');
  }

  bindEvents() {
    // 关闭按钮 & 背景点击
    this.modal.querySelector('#iv-close-btn').onclick = () => this.close();
    this.modal.querySelector('.iv-backdrop').onclick = () => this.close();

    // 缩放按钮事件
    this.modal.querySelector('#iv-zoom-in').onclick = () => this.zoom(1.25);
    this.modal.querySelector('#iv-zoom-out').onclick = () => this.zoom(0.8);
    this.modal.querySelector('#iv-zoom-fit').onclick = () => this.fitToScreen();
    this.modal.querySelector('#iv-zoom-100').onclick = () => this.setZoom(1.0);
    this.modal.querySelector('#iv-rotate').onclick = () => this.rotate();
    this.modal.querySelector('#iv-reset').onclick = () => this.reset();

    // 下载原图
    this.modal.querySelector('#iv-download-btn').onclick = () => {
      if (this.currentSrc) {
        const a = document.createElement('a');
        a.href = this.currentSrc;
        a.download = this.currentTitle || 'harness-diagram.jpg';
        a.click();
      }
    };

    // 滚轮缩放 (Wheel Zoom)
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      this.zoom(zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    // 拖拽平移 (Pan / Drag)
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 只响应左键
      this.isDragging = true;
      this.startX = e.clientX - this.translateX;
      this.startY = e.clientY - this.translateY;
      this.viewport.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.translateX = e.clientX - this.startX;
      this.translateY = e.clientY - this.startY;
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.viewport.style.cursor = 'grab';
      }
    });

    // 双击智能放大/复位 (Double Click)
    this.viewport.addEventListener('dblclick', (e) => {
      if (this.scale > 1.05) {
        this.setZoom(1.0);
      } else {
        this.zoom(2.0, e.clientX, e.clientY);
      }
    });

    // 键盘快捷键监听
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;

      if (e.key === 'Escape') {
        this.close();
      } else if (e.key === '+' || e.key === '=') {
        this.zoom(1.25);
      } else if (e.key === '-' || e.key === '_') {
        this.zoom(0.8);
      } else if (e.key === '0') {
        this.fitToScreen();
      } else if (e.key === '1') {
        this.setZoom(1.0);
      } else if (e.key === 'r' || e.key === 'R') {
        this.rotate();
      }
    });
  }

  openImage(src, title = '高清架构图预览') {
    this.isSvgMode = false;
    this.currentSrc = src;
    this.currentTitle = title;

    this.titleLabel.textContent = title;
    this.targetSvg.style.display = 'none';
    this.targetImg.style.display = 'block';
    this.targetImg.src = src;

    this.reset();
    this.modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  openSvg(svgHtml, title = '矢量架构流程图预览') {
    this.isSvgMode = true;
    this.svgContent = svgHtml;
    this.currentTitle = title;
    this.currentSrc = '';

    this.titleLabel.textContent = title;
    this.targetImg.style.display = 'none';
    this.targetSvg.style.display = 'block';
    this.targetSvg.innerHTML = svgHtml;

    this.reset();
    this.modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  close() {
    this.modal.classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(() => {
      this.targetImg.src = '';
      this.targetSvg.innerHTML = '';
    }, 200);
  }

  isOpen() {
    return this.modal.classList.contains('active');
  }

  zoom(factor, focalX, focalY) {
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    if (newScale === this.scale) return;

    if (focalX !== undefined && focalY !== undefined) {
      const rect = this.viewport.getBoundingClientRect();
      const originX = focalX - rect.left - rect.width / 2;
      const originY = focalY - rect.top - rect.height / 2;
      
      this.translateX -= (originX - this.translateX) * (factor - 1);
      this.translateY -= (originY - this.translateY) * (factor - 1);
    }

    this.scale = newScale;
    this.applyTransform();
  }

  setZoom(exactScale) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, exactScale));
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  fitToScreen() {
    this.scale = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  rotate() {
    this.rotateDeg = (this.rotateDeg + 90) % 360;
    this.applyTransform();
  }

  reset() {
    this.scale = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.rotateDeg = 0;
    this.applyTransform();
  }

  applyTransform() {
    this.transformLayer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotateDeg}deg)`;
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }
}

// 导出全局单例
window.ImageViewerInstance = new InteractiveImageViewer();
