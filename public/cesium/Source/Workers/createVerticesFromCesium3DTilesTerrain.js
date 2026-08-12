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
  Cesium3DTilesTerrainGeometryProcessor_default
} from "./chunk-TMXJHKIL.js";
import "./chunk-4BUKLFXQ.js";
import "./chunk-LNWG6AVH.js";
import {
  createTaskProcessorWorker_default
} from "./chunk-DX7XEAAO.js";
import "./chunk-CUCL7UUA.js";
import "./chunk-CXZ7F365.js";
import "./chunk-SLHUDYBY.js";
import "./chunk-XJL6DIW2.js";
import "./chunk-LZDKUOOV.js";
import "./chunk-QDPBMUCP.js";
import "./chunk-Z6I34JO7.js";
import "./chunk-5NQUQKTI.js";
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

// packages/engine/Source/Workers/createVerticesFromCesium3DTilesTerrain.js
function createVerticesFromCesium3DTilesTerrain(options, transferableObjects) {
  const meshPromise = Cesium3DTilesTerrainGeometryProcessor_default.createMesh(options);
  return meshPromise.then(function(mesh) {
    const verticesBuffer = mesh.vertices.buffer;
    const indicesBuffer = mesh.indices.buffer;
    const westIndicesBuffer = mesh.westIndicesSouthToNorth.buffer;
    const southIndicesBuffer = mesh.southIndicesEastToWest.buffer;
    const eastIndicesBuffer = mesh.eastIndicesNorthToSouth.buffer;
    const northIndicesBuffer = mesh.northIndicesWestToEast.buffer;
    transferableObjects.push(
      verticesBuffer,
      indicesBuffer,
      westIndicesBuffer,
      southIndicesBuffer,
      eastIndicesBuffer,
      northIndicesBuffer
    );
    return {
      verticesBuffer,
      indicesBuffer,
      vertexCountWithoutSkirts: mesh.vertexCountWithoutSkirts,
      indexCountWithoutSkirts: mesh.indexCountWithoutSkirts,
      encoding: mesh.encoding,
      westIndicesBuffer,
      southIndicesBuffer,
      eastIndicesBuffer,
      northIndicesBuffer
    };
  });
}
var createVerticesFromCesium3DTilesTerrain_default = createTaskProcessorWorker_default(
  createVerticesFromCesium3DTilesTerrain
);
export {
  createVerticesFromCesium3DTilesTerrain_default as default
};
