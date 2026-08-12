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
  PrimitivePipeline_default
} from "./chunk-JL3G7ECO.js";
import {
  createTaskProcessorWorker_default
} from "./chunk-DX7XEAAO.js";
import "./chunk-CUCL7UUA.js";
import "./chunk-FOSEHTJV.js";
import "./chunk-SLHUDYBY.js";
import "./chunk-U2AB7OGP.js";
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
import "./chunk-OU4VVTDN.js";
import "./chunk-ENHI34A6.js";
import "./chunk-472NU6BZ.js";
import "./chunk-RONMVTES.js";
import "./chunk-SU626SVA.js";

// packages/engine/Source/Workers/combineGeometry.js
function combineGeometry(packedParameters, transferableObjects) {
  const parameters = PrimitivePipeline_default.unpackCombineGeometryParameters(packedParameters);
  const results = PrimitivePipeline_default.combineGeometry(parameters);
  return PrimitivePipeline_default.packCombineGeometryResults(
    results,
    transferableObjects
  );
}
var combineGeometry_default = createTaskProcessorWorker_default(combineGeometry);
export {
  combineGeometry_default as default
};
