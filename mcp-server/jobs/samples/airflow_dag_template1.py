from datetime import datetime
import boto3

from airflow import DAG
from airflow.operators.empty import EmptyOperator
from airflow.providers.amazon.aws.operators.glue import GlueJobOperator
from airflow.providers.amazon.aws.operators.glue_crawler import GlueCrawlerOperator

# ── Connection / region config ────────────────────────────────────────────────
AWS_CONN_ID = "aws_default"
REGION      = "us-east-1"

# ── SNS failure notification ──────────────────────────────────────────────────
SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:your-sns-topic"


def notify_sns_on_failure(context):
    dag_id    = context["dag"].dag_id
    task_id   = context["task_instance"].task_id
    run_id    = context["run_id"]
    log_url   = context["task_instance"].log_url
    exception = context.get("exception")

    subject = f"[AIRFLOW][FAILED] {dag_id}.{task_id}"
    message = (
        f"DAG: {dag_id}\n"
        f"Task: {task_id}\n"
        f"Run ID: {run_id}\n"
        f"Log: {log_url}\n\n"
        f"Exception:\n{exception}\n"
    )

    boto3.client("sns", region_name=REGION).publish(
        TopicArn=SNS_TOPIC_ARN,
        Subject=subject[:100],
        Message=message,
    )


# ── Helper factories (mirrors caldap_glue_jobs_and_crawlers gold standard) ───

def glue_job(task_id, job_name):
    return GlueJobOperator(
        task_id=task_id,
        job_name=job_name,
        aws_conn_id=AWS_CONN_ID,
        region_name=REGION,
        wait_for_completion=True,
        on_failure_callback=notify_sns_on_failure,
    )


def glue_crawler(task_id, crawler_name):
    return GlueCrawlerOperator(
        task_id=task_id,
        aws_conn_id=AWS_CONN_ID,
        region_name=REGION,
        wait_for_completion=True,
        on_failure_callback=notify_sns_on_failure,
        config={"Name": crawler_name},
    )


# ── DAG ───────────────────────────────────────────────────────────────────────
# Terraform schedule: cron(45 12 * * ? *)  →  Airflow cron: "45 12 * * *"
# (AWS cron uses a 6-field format with a ? for day-of-week; Airflow uses
#  standard 5-field POSIX cron — the semantics are identical: daily 12:45 UTC)

with DAG(
    dag_id="edw_caldap_cerkl_data_wflow",
    start_date=datetime(2025, 1, 1),
    schedule="45 12 * * *",   # daily at 12:45 UTC — from wflow1 SCHEDULED trigger
    catchup=False,
    tags=["glue", "crawler", "caldap", "cerkl"],
) as dag:

    start = EmptyOperator(task_id="start")

    # ── MASTER kickoff job (wflow1 — SCHEDULED trigger) ───────────────────────
    master = glue_job("edw_ing_caldap_member_data", "edw_ing_caldap_member_data")
    start >> master

    # ── PATH A — Member data (wflow2 → wflow3 → wflow4) ──────────────────────
    # wflow2 : master SUCCEEDED  → crawler edw_ing_caldap_member_data_table
    # wflow3 : crawler above SUCCEEDED → job edw_cur_caldap_member_data
    # wflow4 : job above SUCCEEDED     → crawler edw_cur_caldap_member_data_table

    a1 = glue_crawler("edw_ing_caldap_member_data_table",
                      "edw_ing_caldap_member_data_table")
    a2 = glue_job("edw_cur_caldap_member_data",
                  "edw_cur_caldap_member_data")
    a3 = glue_crawler("edw_cur_caldap_member_data_table",
                      "edw_cur_caldap_member_data_table")

    master >> a1 >> a2 >> a3

    # ── PATH B — Department-number data (wflow5 → wflow6 → wflow7 → wflow8) ──
    # wflow5 : master SUCCEEDED                          → job  edw_ing_caldap_departmentnumber_data
    # wflow6 : job above SUCCEEDED                       → crawler edw_ing_caldap_departmentnumber_data_table
    # wflow7 : crawler above SUCCEEDED                   → job  edw_cur_caldap_departmentnumber_data
    # wflow8 : job above SUCCEEDED                       → crawler edw_cur_caldap_departmentnumber_data_table

    b1 = glue_job("edw_ing_caldap_departmentnumber_data",
                  "edw_ing_caldap_departmentnumber_data")
    b2 = glue_crawler("edw_ing_caldap_departmentnumber_data_table",
                      "edw_ing_caldap_departmentnumber_data_table")
    b3 = glue_job("edw_cur_caldap_departmentnumber_data",
                  "edw_cur_caldap_departmentnumber_data")
    b4 = glue_crawler("edw_cur_caldap_departmentnumber_data_table",
                      "edw_cur_caldap_departmentnumber_data_table")

    master >> b1 >> b2 >> b3 >> b4

    # ── PATH C — Person data (wflow9 → wflow10) ───────────────────────────────
    # wflow9  : master SUCCEEDED → job  edw_ing_caldap_person
    # wflow10 : job above SUCCEEDED → crawler edw_caldap_person

    c1 = glue_job("edw_ing_caldap_person", "edw_ing_caldap_person")
    c2 = glue_crawler("edw_caldap_person", "edw_caldap_person")

    master >> c1 >> c2

    # ── PATH D — Department hierarchy (wflow13 → wflow14) ────────────────────
    # wflow13 : master SUCCEEDED                → job  edw_ing_department_hierarchy_d
    # wflow14 : job above SUCCEEDED             → crawler edw_ing_department_hierarchy_d_data_table
    # NOTE: wflow15/wflow16 (curated hierarchy path) are commented-out in
    #       the .tf file and are therefore intentionally excluded from this DAG.

    d1 = glue_job("edw_ing_department_hierarchy_d",
                  "edw_ing_department_hierarchy_d")
    d2 = glue_crawler("edw_ing_department_hierarchy_d_data_table",
                      "edw_ing_department_hierarchy_d_data_table")

    master >> d1 >> d2

    # ── FAN-IN join (wflow17 predicate — ALL 4 branch-end crawlers AND) ───────
    # Terraform predicate conditions (logical = "AND"):
    #   edw_cur_caldap_member_data_table         SUCCEEDED  (a3)
    #   edw_cur_caldap_departmentnumber_data_table SUCCEEDED (b4)
    #   edw_caldap_person                         SUCCEEDED  (c2)
    #   edw_ing_department_hierarchy_d_data_table SUCCEEDED  (d2)

    join_all_paths = EmptyOperator(
        task_id="join_all_paths",
        trigger_rule="all_success",   # enforces the AND logical of wflow17
    )

    [a3, b4, c2, d2] >> join_all_paths

    # ── POST-FAN-IN — CERKL curated job + crawler (wflow17 → wflow18) ─────────
    # wflow17 action : job  edw_cur_caldap_cerkl_data
    # wflow18 action : crawler edw_cur_caldap_cerkl_data_table

    x1 = glue_job("edw_cur_caldap_cerkl_data", "edw_cur_caldap_cerkl_data")
    x2 = glue_crawler("edw_cur_caldap_cerkl_data_table",
                      "edw_cur_caldap_cerkl_data_table")

    join_all_paths >> x1 >> x2

    # ── End ───────────────────────────────────────────────────────────────────
    end = EmptyOperator(task_id="end")
    x2 >> end


# ════════════════════════════════════════════════════════════════════════════════
# SIDE-BY-SIDE COMPARISON: caldap_glue_jobs_and_crawlers (gold standard)
#                      vs. edw_caldap_cerkl_data_wflow (this DAG)
# ════════════════════════════════════════════════════════════════════════════════
#
# Aspect                     │ Gold Standard DAG                 │ This DAG
# ───────────────────────────┼───────────────────────────────────┼──────────────────────────────────────
# dag_id                     │ caldap_glue_jobs_and_crawlers     │ edw_caldap_cerkl_data_wflow
# schedule                   │ None (manual)                     │ "45 12 * * *" (daily 12:45 UTC)
#                            │                                   │   ← derived from SCHEDULED trigger
# Helper functions           │ glue_job() + glue_crawler()       │ Identical — copy-preserved
# Failure notification       │ notify_sns_on_failure (SNS)       │ Identical — copy-preserved
# start / end sentinels      │ EmptyOperator start + end         │ Identical
# Root / master task         │ glue_job  (edw_ing_caldap_        │ glue_job (edw_ing_caldap_member_data)
#                            │            member_data)           │   ← same job, same pattern
# Fan-out branches           │ 4 parallel paths from master      │ 4 parallel paths from master
#   Path variable names      │ s1_*, s2_*, s3_*, s4_*            │ a*, b*, c*, d*  (semantic naming)
#   Branch A (member)        │ s4_1(crawler)→s4_2(job)→s4_3(cr) │ a1(crawler)→a2(job)→a3(crawler)
#   Branch B (dept#)         │ s3_1→s3_2→s3_3→s3_4              │ b1→b2→b3→b4   (identical depth)
#   Branch C (person)        │ s2_1(job)→s2_2(crawler)           │ c1(job)→c2(crawler)
#   Branch D (dept hierarchy)│ s1_1(job)→s1_2(crawler)           │ d1(job)→d2(crawler)
# Fan-in gate                │ EmptyOperator join_all_sets       │ EmptyOperator join_all_paths
#   trigger_rule             │ default (all_success implied)     │ explicit trigger_rule="all_success"
#   Feeding tasks            │ [s1_2, s2_2, s3_4, s4_3]         │ [a3, b4, c2, d2]
# Post-fan-in chain          │ x1(job) → x2(crawler)             │ x1(job) → x2(crawler)  (identical)
#   Job                      │ edw_cur_caldap_cerkl_data         │ edw_cur_caldap_cerkl_data  (same)
#   Crawler                  │ edw_cur_caldap_cerkl_data_table   │ edw_cur_caldap_cerkl_data_table (same)
# Disabled/commented nodes   │ N/A                               │ wflow11,12,15,16 excluded (EMPTITLE
#                            │                                   │   CODE & CUR_DEPT_HIERARCHY paths)
# Total active task nodes    │ 14 (1 master + 4 paths + join     │ 15 (same structure; Branch A starts
#                            │     + 2 post-fanin + start + end) │   with crawler not job — +1 node)
# ════════════════════════════════════════════════════════════════════════════════
# VERDICT: Structure is a faithful 1:1 translation of the gold standard pattern.
# The only intentional differences are the DAG id, the schedule (from the
# SCHEDULED trigger), semantic branch variable names (a/b/c/d vs s1/s2/s3/s4),
# and the explicit trigger_rule on the fan-in gate which makes the AND predicate
# of wflow17 unambiguous in Airflow.
# ════════════════════════════════════════════════════════════════════════════════
