/** Cesium TileReplacementQueue 双向链表节点。 */
interface ReplacementNode<T> {
  /** 瓦片唯一键。 */
  key: string;
  /** 瓦片状态对象。 */
  value: T;
  /** 更近使用的节点。 */
  previous?: ReplacementNode<T>;
  /** 更久未使用的节点。 */
  next?: ReplacementNode<T>;
}

/**
 * Cesium TileReplacementQueue 的渲染器无关移植。
 * 链表头是本帧最近触碰的瓦片，帧开始哨兵确保当前帧访问过的瓦片绝不被淘汰。
 */
export class CesiumTileReplacementQueue<T> {
  private readonly nodes = new Map<string, ReplacementNode<T>>();
  private head?: ReplacementNode<T>;
  private tail?: ReplacementNode<T>;
  private lastBeforeStartOfFrame?: ReplacementNode<T>;

  /** 当前 replacement queue 中的瓦片数量。 */
  public get count(): number { return this.nodes.size; }

  /** 标记一帧开始；哨兵之前的瓦片随后会被本帧 touch 移到链表头。 */
  public markStartOfRenderFrame(): void {
    this.lastBeforeStartOfFrame = this.head;
  }

  /**
   * 对齐 Cesium markTileRendered，将本帧访问的瓦片移动到链表头。
   * @param key 瓦片唯一键。
   * @param value 瓦片状态对象。
   */
  public markTileRendered(key: string, value: T): void {
    let node = this.nodes.get(key);
    if (!node) {
      node = { key, value };
      this.nodes.set(key, node);
    } else {
      node.value = value;
    }
    if (this.head === node) {
      if (node === this.lastBeforeStartOfFrame) this.lastBeforeStartOfFrame = node.next;
      return;
    }
    this.unlink(node, false);
    node.previous = undefined;
    node.next = this.head;
    if (this.head) this.head.previous = node;
    else this.tail = node;
    this.head = node;
  }

  /**
   * 对齐 Cesium trimTiles，从尾部释放本帧未触碰且允许卸载的瓦片。
   * @param maximumTiles 最大缓存瓦片数。
   * @param eligible 判断瓦片当前是否允许卸载。
   * @param unload 执行地形、影像和 ECS 资源释放。
   */
  public trimTiles(maximumTiles: number, eligible: (value: T, key: string) => boolean, unload: (value: T, key: string) => void): void {
    let node = this.tail;
    let keepTrimming = true;
    while (keepTrimming && this.lastBeforeStartOfFrame && this.nodes.size > maximumTiles && node) {
      keepTrimming = node !== this.lastBeforeStartOfFrame;
      const previous = node.previous;
      if (eligible(node.value, node.key)) {
        this.unlink(node, true);
        unload(node.value, node.key);
      }
      node = previous;
    }
  }

  /** 清空 replacement queue 的链表引用。 */
  public clear(): void {
    this.nodes.clear();
    this.head = undefined;
    this.tail = undefined;
    this.lastBeforeStartOfFrame = undefined;
  }

  /**
   * 从双向链表移除节点。
   * @param node 待移除节点。
   * @param removeFromMap 是否同时移除键索引。
   */
  private unlink(node: ReplacementNode<T>, removeFromMap: boolean): void {
    if (node === this.lastBeforeStartOfFrame) this.lastBeforeStartOfFrame = node.next;
    if (node.previous) node.previous.next = node.next;
    else if (this.head === node) this.head = node.next;
    if (node.next) node.next.previous = node.previous;
    else if (this.tail === node) this.tail = node.previous;
    node.previous = undefined;
    node.next = undefined;
    if (removeFromMap) this.nodes.delete(node.key);
  }
}
