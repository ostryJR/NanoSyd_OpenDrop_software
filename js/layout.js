/* Electrode layouts, screen geometry and hit-testing, ported from OpenDropController4_25.pde. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./layouts-data.js'));
  else (root.OD = root.OD || {}).layout = factory(root.OD.layoutData);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (layoutData) {
  'use strict';

  // The original positions everything relative to OpenDropFrame.png (2226 x 1200 px):
  //   coX(u) = img.width/2 + u * eSize/2,  coY(v) = img.height/2 - imageShift + v * eSize/2
  // with eSize = 46 and imageShift = 47, so one grid unit is 23 px of the image.
  const GEOMETRY = Object.freeze({ IMG_W: 2226, IMG_H: 1200, CX: 1113, CY: 553, UNIT: 23 });

  const inRect = (mx, my, x, y, w, h) => mx >= x && mx < x + w && my >= y && my < y + h;

  // Electrodes only react inside this box (grid units), as in the original's mouse handlers.
  const inArray = (mx, my) => mx > -24 && mx < 24 && my > -12 && my < 12;

  const LABELS = {
    electrodes: 'Standard (electrodes.json)',
    electrodes_magnet: 'Magnet (electrodes_magnet.json)',
  };

  const LAYOUTS = Object.keys(layoutData).map((id) => ({
    id,
    label: LABELS[id] || id + '.json',
    // The reservoir buttons drive electrodes 0-9 and 113-127 of the standard cartridge.
    hasReservoirs: id === 'electrodes' || id === 'electrodes_magnet',
    rects: layoutData[id],
  }));

  const getLayout = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];

  // Distinct electrode IDs whose rectangle contains the point (grid units).
  function hitTest(rects, mx, my) {
    const hits = [];
    for (const r of rects) {
      if (inRect(mx, my, r.x, r.y, r.h, r.v) && !hits.includes(r.e)) hits.push(r.e);
    }
    return hits;
  }

  return { GEOMETRY, LAYOUTS, getLayout, hitTest, inArray, inRect };
});
