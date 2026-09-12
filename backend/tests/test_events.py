from backend.events import EventBus


def test_publish_reaches_subscriber():
    bus = EventBus()
    q = bus.subscribe()
    bus.publish("remind", {"id": 1, "title": "小组会议"})
    msg = q.get_nowait()
    assert msg.startswith("event: remind\n")
    assert '"id": 1' in msg
    assert msg.endswith("\n\n")


def test_publish_without_subscribers_is_noop():
    EventBus().publish("x", {"a": 1})  # 不应抛异常


def test_unsubscribe_stops_delivery():
    bus = EventBus()
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.publish("x", {})
    assert q.empty()


def test_stream_yields_event_then_heartbeat():
    bus = EventBus()
    gen = bus.stream(heartbeat=0.05)
    assert next(gen) == ": connected\n\n"
    bus.publish("sync_done", {"added": 1})
    assert next(gen).startswith("event: sync_done\n")
    assert next(gen) == ": heartbeat\n\n"
    gen.close()


def test_slow_subscriber_does_not_block_publish():
    bus = EventBus(max_queue=1)
    q = bus.subscribe()
    bus.publish("a", {})
    bus.publish("b", {})  # 队列已满：静默丢弃，不阻塞
    assert q.qsize() == 1
