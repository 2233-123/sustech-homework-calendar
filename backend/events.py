"""SSE 事件总线：进程内发布/订阅，供 Flask SSE 端点使用。"""
from __future__ import annotations

import json
import queue
import threading


class EventBus:
    def __init__(self, max_queue: int = 100):
        self._lock = threading.Lock()
        self._subscribers: list = []
        self._max_queue = max_queue

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=self._max_queue)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, event: str, data: dict) -> None:
        """向所有订阅者广播一条 SSE 事件（某订阅者队列满则丢弃其本条）。"""
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def stream(self, heartbeat: float = 15.0):
        """SSE 生成器：推送事件 + 周期心跳；生成器关闭时自动退订。"""
        q = self.subscribe()
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield q.get(timeout=heartbeat)
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            self.unsubscribe(q)
