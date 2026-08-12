/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.136.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

import {
  EllipseGeometry_default
} from "./chunk-JXZENNQJ.js";
import "./chunk-JU7SRUHW.js";
import "./chunk-BNQP2O5C.js";
import "./chunk-FOSEHTJV.js";
import "./chunk-SLHUDYBY.js";
import "./chunk-U2AB7OGP.js";
import "./chunk-DB764AP5.js";
import "./chunk-E6ZBSRS4.js";
import "./chunk-QDPBMUCP.js";
import "./chunk-Z6I34JO7.js";
import "./chunk-5NQUQKTI.js";
import "./chunk-UEOK5HNA.js";
import "./chunk-WET6VWST.js";
import "./chunk-T6OZDZJN.js";
import "./chunk-LMIRXBYQ.js";
import "./chunk-Y2NKZCM6.js";
import "./chunk-5KGVSWUQ.js";
import "./chunk-X63WTUJB.js";
import "./chunk-FCNXQRRE.js";
import "./chunk-IUYXPOMY.js";
import {
  Ellipsoid_default
} from "./chunk-OU4VVTDN.js";
import {
  Cartesian3_default
} from "./chunk-ENHI34A6.js";
import "./chunk-472NU6BZ.js";
import "./chunk-RONMVTES.js";
import {
  defined_default
} from "./chunk-SU626SVA.js";

// packages/engine/Source/Workers/createEllipseGeometry.js
function createEllipseGeometry(ellipseGeometry, offset) {
  if (defined_default(offset)) {
    ellipseGeometry = EllipseGeometry_default.unpack(ellipseGeometry, offset);
  }
  ellipseGeometry._center = Cartesian3_default.clone(ellipseGeometry._center);
  ellipseGeometry._ellipsoid = Ellipsoid_default.clone(ellipseGeometry._ellipsoid);
  return EllipseGeometry_default.createGeometry(ellipseGeometry);
}
var createEllipseGeometry_default = createEllipseGeometry;
export {
  createEllipseGeometry_default as default
};
