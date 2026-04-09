"""Custom sensors for Lattik DAGs."""

from __future__ import annotations

import urllib.error
import urllib.request

from airflow.sensors.base import BaseSensorOperator


class DataReadySensor(BaseSensorOperator):
    """Poke the Iceberg REST catalog until the source table exists.

    Checks ``GET /v1/namespaces/{ns}/tables/{table}`` on the Iceberg REST
    catalog.  Returns *True* (ready) on HTTP 200, *False* on 404.
    """

    template_fields = ("table",)

    def __init__(self, *, table: str, iceberg_rest_url: str, **kwargs):
        super().__init__(**kwargs)
        self.table = table
        self.iceberg_rest_url = iceberg_rest_url

    def poke(self, context) -> bool:
        parts = self.table.split(".", 1)
        if len(parts) != 2:
            raise ValueError(
                f"Table must be 'namespace.table', got: {self.table}"
            )
        namespace, table_name = parts

        url = (
            f"{self.iceberg_rest_url}/v1/namespaces/{namespace}"
            f"/tables/{table_name}"
        )
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    self.log.info("Table %s is ready", self.table)
                    return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self.log.info("Table %s not found yet", self.table)
                return False
            raise
        except Exception:
            self.log.exception("Error checking table %s", self.table)
            return False
        return False
