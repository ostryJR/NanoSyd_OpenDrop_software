/* SVG drawing of the original controller screen (drawPlane and Electrode.drawElectrode). */
(function (root) {
  'use strict';

  const OD = root.OD;
  const G = OD.layout.GEOMETRY;
  const NS = 'http://www.w3.org/2000/svg';
  const px = (u) => G.CX + G.UNIT * u; // the original's coX()
  const py = (v) => G.CY + G.UNIT * v; // the original's coY()
  const BOX = 2 * G.UNIT; // button size (eSize)

  const COLOR = {
    on: 'rgb(0,200,0)',
    off: 'rgb(250,200,0)',
    previous: 'rgb(210,200,0)', // off now, on in the previous frame
    button: 'rgb(255,0,0)',
    active: 'rgb(255,255,255)',
    idle: 'rgb(150,150,150)',
  };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  class BoardView {
    constructor(svg, imageHref) {
      svg.setAttribute('viewBox', `0 0 ${G.IMG_W} ${G.IMG_H}`);
      el('image', { href: imageHref, x: 0, y: 0, width: G.IMG_W, height: G.IMG_H }, svg);

      const labels = el('g', { class: 'labels' }, svg);
      const label = (text, u, v) => {
        const t = el('text', { x: px(u), y: py(v) }, labels);
        t.textContent = text;
        return t;
      };
      label('OpenDrop Generator', -43, -18);
      label('save', 32, -18.5);
      label('load', 38, -18.5);
      label('play', 37, -7.5);
      label('copy last frame', 37, 5.5);
      label('clear frame', 37, 8.5);
      label('clear all', 37, 11.5);
      label('frame_no:', -20, 16);
      label('frames/min:', 10, 16);
      this.frameLabel = label('', -12, 16);
      this.speedLabel = label('', 18, 16);

      this.electrodeLayer = el('g', { class: 'electrodes' }, svg);
      this.numberLayer = el('g', { class: 'numbers' }, svg);

      const controls = el('g', { class: 'controls' }, svg);
      const box = (u, v, parent = controls) =>
        el('rect', { x: px(u), y: py(v), width: BOX, height: BOX, fill: COLOR.button }, parent);
      this.playBox = box(34, -9);
      box(34, 4); // copy last frame
      box(34, 7); // clear frame
      box(34, 10); // clear all
      this.reservoirButtons = el('g', {}, controls);
      for (const [u, v] of [[28, -6], [28, 4], [-30, -6], [-30, 4]]) box(u, v, this.reservoirButtons);

      // Frame dots 1..17 and the previous/next arrows.
      this.dots = [];
      for (let i = 1; i < 18; i++) this.dots.push(el('circle', { cx: px(-18 + i * 2), cy: py(19.5), r: 15 }, controls));
      const y = py(19.5);
      const arrow = (tipU, dir) => {
        const tip = px(tipU);
        const base = tip + dir * BOX;
        return el('polygon', { points: `${tip},${y} ${base},${y - BOX / 2} ${base},${y + BOX / 2}`, fill: COLOR.idle }, controls);
      };
      arrow(-20, 1);
      this.nextArrow = arrow(20, -1);

      this.rects = [];
    }

    setLayout(lay) {
      this.electrodeLayer.replaceChildren();
      this.numberLayer.replaceChildren();
      this.rects = lay.rects.map((r) => {
        const node = el('rect', { x: px(r.x), y: py(r.y), width: G.UNIT * r.h, height: G.UNIT * r.v }, this.electrodeLayer);
        const number = el('text', { x: px(r.x + r.h / 2), y: py(r.y + r.v / 2) }, this.numberLayer);
        number.textContent = r.e;
        return { node, e: r.e, fill: null };
      });
      this.reservoirButtons.style.display = lay.hasReservoirs ? '' : 'none';
    }

    render(ed, showNumbers) {
      const { seq, frame } = ed;
      for (const r of this.rects) {
        const fill = seq.get(r.e, frame) ? COLOR.on : seq.get(r.e, frame - 1) ? COLOR.previous : COLOR.off;
        if (fill !== r.fill) {
          r.node.setAttribute('fill', fill);
          r.fill = fill;
        }
      }
      this.frameLabel.textContent = frame;
      this.speedLabel.textContent = ed.speed;
      this.playBox.setAttribute('fill', ed.playing ? COLOR.active : COLOR.button);
      this.dots.forEach((dot, i) => dot.setAttribute('fill', i + 1 === frame ? COLOR.button : COLOR.idle));
      this.nextArrow.setAttribute('fill', frame >= 18 ? COLOR.button : COLOR.idle);
      this.numberLayer.style.display = showNumbers ? '' : 'none';
    }
  }

  OD.view = { BoardView, COLOR };
})(globalThis);
