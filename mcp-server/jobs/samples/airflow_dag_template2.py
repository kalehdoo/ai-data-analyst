from datetime import datetime
import boto3

from airflow import DAG
from airflow.operators.empty import EmptyOperator
from airflow.providers.amazon.aws.operators.glue import GlueJobOperator
from airflow.providers.amazon.aws.operators.glue_crawler import GlueCrawlerOperator

AWS_CONN_ID = "aws_default"
REGION = "us-west-2"

SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:your-sns-topic"

def notify_sns_on_failure(context):
    dag_id = context["dag"].dag_id
    task_id = context["task_instance"].task_id
    run_id = context["run_id"]
    log_url = context["task_instance"].log_url
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

with DAG(
    dag_id="caldap_glue_jobs_and_crawlers", ###
    start_date=datetime(2025, 1, 1),
    schedule=None, ###
    catchup=False,
    tags=["glue", "crawler"],
) as dag:

    start = EmptyOperator(task_id="start")

    # Master kickoff job
    master = glue_job("edw_ing_caldap_member_data", "edw_ing_caldap_member_data")
    start >> master

    s1_1 = glue_job("edw_ing_department_hierarchy_d", "edw_ing_department_hierarchy_d")
    s1_2 = glue_crawler("edw_department_hierarchy_d", "edw_department_hierarchy_d")
    master >> s1_1 >> s1_2

 
    s2_1 = glue_job("edw_ing_caldap_person", "edw_ing_caldap_person")
    s2_2 = glue_crawler("edw_caldap_person", "edw_caldap_person")
    master >> s2_1 >> s2_2


    s3_1 = glue_job("edw_ing_caldap_departmentnumber_data", "edw_ing_caldap_departmentnumber_data")
    s3_2 = glue_crawler("edw_ing_caldap_departmentnumber_data_table","edw_ing_caldap_departmentnumber_data_table")
    s3_3 = glue_job("edw_cur_caldap_departmentnumber_data", "edw_cur_caldap_departmentnumber_data")
    s3_4 = glue_crawler("edw_cur_caldap_departmentnumber_data_table","edw_cur_caldap_departmentnumber_data_table")

    master >> s3_1 >> s3_2 >> s3_3 >> s3_4

    # ---------------- set4 (member curated path) ----------------
    s4_1 = glue_crawler("edw_ing_caldap_member_data_table","edw_ing_caldap_member_data_table")
    s4_2 = glue_job("edw_cur_caldap_member_data", "edw_cur_caldap_member_data")
    s4_3 = glue_crawler("edw_cur_caldap_member_data_table", "edw_cur_caldap_member_data_table")

    master >> s4_1 >> s4_2 >> s4_3

    join_all_sets = EmptyOperator(task_id="join_all_sets")
    [s1_2, s2_2, s3_4, s4_3] >> join_all_sets

    x1 = glue_job("edw_cur_caldap_cerkl_data", "edw_cur_caldap_cerkl_data")
    x2 = glue_crawler("edw_cur_caldap_cerkl_data_table", "edw_cur_caldap_cerkl_data_table")
    join_all_sets >> x1 >> x2

    end = EmptyOperator(task_id="end")
    x2 >> end