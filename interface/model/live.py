"""Bounded snapshots and entity deltas for the read-only model endpoint."""
from collections import OrderedDict
from hashlib import sha256
import json


def identity(entity):
    return entity.get('uid') or entity['id']


class Revisions:
    def __init__(self, keep=4):
        self.keep = keep
        self.snapshots = OrderedDict()
        self.stamp = None
        self.current = None

    def publish(self, model, stamp):
        entities = model.get('entities', [])
        ids = [identity(e) for e in entities]
        if len(ids) != len(set(ids)):
            raise ValueError('The model contains duplicate entity identities')
        revision = sha256(json.dumps(model, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        self.snapshots[revision] = model
        self.snapshots.move_to_end(revision)
        while len(self.snapshots) > self.keep:
            self.snapshots.popitem(last=False)
        self.current, self.stamp = revision, stamp

    def response(self, since=None):
        current = self.snapshots[self.current]
        common = {'revision': self.current, 'stamp': self.stamp}
        previous = self.snapshots.get(since)
        if previous is None:
            return {**current, **common, 'mode': 'snapshot'}
        old = {identity(e): e for e in previous['entities']}
        new = {identity(e): e for e in current['entities']}
        delta = {**common, 'mode': 'delta', 'base': since,
                 'upsert': [e for key, e in new.items() if old.get(key) != e],
                 'remove': [key for key in old if key not in new],
                 'metadata': {k: v for k, v in current.items() if k != 'entities' and previous.get(k) != v}}
        if list(old) != list(new):
            delta['order'] = list(new)
        return delta
