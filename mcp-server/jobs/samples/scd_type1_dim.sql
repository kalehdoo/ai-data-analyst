/* Type 1 Dimension Model - Creates tables for Full Load or upserts for Incremental Loads */

{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['voucher_id', 'business_unit_code_id'],
    contract={'enforced': true},
    dist='voucher_id',
    sort=['voucher_id', 'business_unit_code_id'],
    incremental_predicates=[
        "DBT_INTERNAL_DEST.row_hash <> DBT_INTERNAL_SOURCE.row_hash"
    ],
    merge_exclude_columns=[
        'source_system_add_dt',
        'dw_record_insert_dt',
        'dw_record_insert_id',
        'last_dw_updt_session_begin_dt',
        'last_dw_updt_session_nm',
        'source_system_operator_id'
    ],
    on_schema_change='fail',
    tags=['dim'],
    post_hook=["
insert into {{ this }} (
    voucher_sk,
    voucher_id,
    business_unit_code_id,
    voucher_type_cd,
    voucher_type_desc,
    voucher_invoice_id,
    voucher_invoice_dt,
    purchase_order_id,
    voucher_source_cd,
    voucher_source_desc,
    voucher_style_cd,
    voucher_style_desc,
    origin_cd,
    voucher_desc,
    doc_currency_cd,
    dept_id,
    routing_org_node,
    organization_node_level_nbr,
    source_system_cd,
    source_system_desc,
    source_system_add_dt,
    source_system_modified_dt,
    source_system_operator_id,
    last_dw_updt_session_nm,
    last_dw_updt_session_begin_dt,
    dw_record_insert_dt,
    dw_record_insert_id,
    dw_record_update_dt,
    dw_record_update_id,
    row_hash
)
select
    cast(md5('-|-') as varchar(32)) as voucher_sk,

    cast('-' as varchar(10)) as voucher_id,
    cast('-' as varchar(5)) as business_unit_code_id,
    cast('-' as varchar(1)) as voucher_type_cd,
    cast('-' as varchar(40)) as voucher_type_desc,
    cast('-' as varchar(30)) as voucher_invoice_id,
    cast(null as timestamp) as voucher_invoice_dt,

    cast('-' as varchar(10)) as purchase_order_id,
    cast('-' as varchar(4)) as voucher_source_cd,
    cast('-' as varchar(40)) as voucher_source_desc,
    cast('-' as varchar(4)) as voucher_style_cd,
    cast('-' as varchar(40)) as voucher_style_desc,

    cast('-' as varchar(3)) as origin_cd,
    cast('-' as varchar(254)) as voucher_desc,
    cast('-' as varchar(3)) as doc_currency_cd,

    cast('-' as varchar(5)) as dept_id,
    cast('-' as varchar(6)) as routing_org_node,
    cast(null as smallint) as organization_node_level_nbr,

    cast('{{ var('source_system_cd') }}' as varchar(2)) as source_system_cd,
    cast('Finance' as varchar(40)) as source_system_desc,
    cast(null as timestamp) as source_system_add_dt,
    cast(null as timestamp) as source_system_modified_dt,
    cast('-' as varchar(32)) as source_system_operator_id,

    cast('-' as varchar(60)) as last_dw_updt_session_nm,
    cast(null as timestamp) as last_dw_updt_session_begin_dt,

    cast({{ dbt.current_timestamp() }} as timestamp) as dw_record_insert_dt,
    cast('EDWDEV' as varchar(32)) as dw_record_insert_id,
    cast(null as timestamp) as dw_record_update_dt,
    cast('-' as varchar(32)) as dw_record_update_id,

    cast(md5('-') as varchar(32)) as row_hash

where not exists (
    select 1 from {{ this }}
    where voucher_id = '-'
      and business_unit_code_id = '-'
);
"]
) }}

-- =====================================================
-- 1 DOCS LOOKUP
-- =====================================================
with docs_vch as (

    select
        business_unit,
        doc_id,
        max(deptid) as deptid,
        max(uc_org_node) as uc_org_node,
        max(uc_org_node_level) as uc_org_node_level
    from {{ source('raw_tables', 'wk_ps_uc_orgnode_docs') }}
    where uc_doc_type = 'VCH'
    group by business_unit, doc_id
),

-- =====================================================
-- 2 SOURCE DATA
-- =====================================================
src as (

    select

        -- 🔑 Surrogate Key
        {{ dbt_utils.generate_surrogate_key([
            "rtrim(wk.voucher_id)",
            "rtrim(wk.business_unit)"
        ]) }} as voucher_sk,

        -- Natural Keys
        rtrim(wk.voucher_id)    as voucher_id,
        rtrim(wk.business_unit) as business_unit_code_id,

        -- Attributes
        rtrim(wk.voucher_type) as voucher_type_cd,

        case rtrim(wk.voucher_type)
            when 'V' then 'Registered Voucher'
            when 'X' then 'Template Voucher'
            when 'A' then 'Adjustment Voucher'
            when 'B' then 'Batch Edit Voucher'
            when 'C' then 'Recurring Voucher'
            when 'E' then 'ERS Voucher'
            when 'J' then 'Journal Voucher'
            when 'N' then 'Reversal Voucher'
            when 'P' then 'Prepaid Voucher'
            when 'R' then 'Regular Voucher'
            when 'T' then 'Third Party Voucher'
            else cast(null as varchar(40))
        end as voucher_type_desc,

        ltrim(rtrim(wk.invoice_id)) as voucher_invoice_id,
        cast(wk.invoice_dt as timestamp) as voucher_invoice_dt,
        rtrim(wk.po_id)             as purchase_order_id,
        rtrim(wk.vchr_src)          as voucher_source_cd,

        case rtrim(wk.vchr_src)
            when 'CLBK' then 'Claim Voucher'
            when 'CNTR' then 'Contracts'
            when 'CONS' then 'Consigned Inventory'
            when 'CUST' then 'Custom Interfaces'
            when 'EDI'  then 'EDI'
            when 'FRE'  then 'Real Estate Lease payments'
            when 'MTCH' then 'Debit Memo from Matching'
            when 'NERS' then 'Non PO Evaluated Receipt'
            when 'ONL'  then 'Online'
            when 'PAYR' then 'Payroll/Student Administration'
            when 'PBIL' then 'Pay/Bill Management'
            when 'PERS' then 'PO Evaluated Receipts'
            when 'PPAY' then 'Prepayment'
            when 'PROC' then 'Procurement Cards'
            when 'QUCK' then 'Quick Invoice'
            when 'RBCR' then 'Vendor Rebates'
            when 'TRPM' then 'Promotions Management'
            when 'XML'  then 'XML Invoices'
            when 'SAD'  then 'Student Administration'
            when 'SPRO' then 'Services Procurement'
            when 'SSI'  then 'Self-Service Invoices'
            when 'TADJ' then 'Tax Adjustment'
            when 'AMLS' then 'Asset Lease Payments'
            when 'ARCR' then 'Receivables Customer Refunds'
            when 'BILL' then 'Billing Vouchers'
            when 'RETL' then 'Retail Interface Vouchers'
            when 'RPOV' then 'Recurring PO Voucher'
            when 'RTV'  then 'Return To Vendor (Supplier)'
            else cast(null as varchar(40))
        end as voucher_source_desc,

        rtrim(wk.voucher_style) as voucher_style_cd,

        case rtrim(wk.voucher_style)
            when 'CORR' then 'Reversal Voucher'
            when 'JRNL' then 'Journal Voucher'
            when 'PPAY' then 'Prepaid Voucher'
            when 'REG'  then 'Regular Voucher'
            when 'RGTR' then 'Register Voucher'
            when 'SGLP' then 'Single Payment Voucher'
            when 'THRD' then 'Third Party Voucher'
            when 'TMPL' then 'Template Voucher'
            when 'ADJ'  then 'Adjustments'
            when 'CLBK' then 'Claim Voucher'
            else cast(null as varchar(40))
        end as voucher_style_desc,

        rtrim(wk.origin)         as origin_cd,
        rtrim(wk.descr254_mixed) as voucher_desc,
        wk.txn_currency_cd       as doc_currency_cd,

        trim(docs.deptid)          as dept_id,
        trim(docs.uc_org_node)     as routing_org_node,
        cast(docs.uc_org_node_level as smallint) as organization_node_level_nbr,

        cast('{{ var("source_system_cd") | string }}' as varchar(2)) as source_system_cd,
        srcsys.edw_src_sys_desc       as source_system_desc,

        cast({{ dbt.current_timestamp() }} as timestamp) as source_system_add_dt,
        cast({{ dbt.current_timestamp() }} as timestamp) as source_system_modified_dt,
        cast('dw_VOUCHER_D' as varchar(60))              as last_dw_updt_session_nm,
        cast({{ dbt.current_timestamp() }} as timestamp) as last_dw_updt_session_begin_dt,
        cast(null as varchar(32))     as source_system_operator_id,
		
        -- 🔍 Row Hash
        {{ dbt_utils.generate_surrogate_key([
        "cast(rtrim(wk.voucher_type) as varchar)",
        "cast(ltrim(rtrim(wk.invoice_id)) as varchar)",
        "cast(wk.invoice_dt as varchar)",
        "cast(rtrim(wk.po_id) as varchar)",
        "cast(rtrim(wk.vchr_src) as varchar)",
        "cast(rtrim(wk.voucher_style) as varchar)",
        "cast(rtrim(wk.origin) as varchar)",
        "cast(rtrim(wk.descr254_mixed) as varchar)",
        "cast(wk.txn_currency_cd as varchar)",
        "cast(docs.deptid as varchar)",
        "cast(docs.uc_org_node as varchar)",
        "cast(docs.uc_org_node_level as varchar)",
        "cast('" ~ var('source_system_cd') ~ "' as varchar)"
        ]) }} as row_hash,

        cast({{ dbt.current_timestamp() }} as timestamp) as dw_record_insert_dt,
        cast('EDW' as varchar(32)) as dw_record_insert_id,
        case when {{ is_incremental() }} then cast({{ dbt.current_timestamp() }} as timestamp) else cast(null as timestamp) end as dw_record_update_dt,
        case when {{ is_incremental() }} then cast('EDW' as varchar(32)) else cast(null as varchar(32)) end as dw_record_update_id

    from {{ source('poc_tables', 'wk_ps_voucher') }} wk
    left join docs_vch docs
        on wk.business_unit = docs.business_unit
       and wk.voucher_id   = docs.doc_id
    left join {{ source('enterprise_dim_tables', 'edw_src_sys_type_cd') }} srcsys
        on srcsys.edw_src_sys_cd = cast('{{ var("source_system_cd") }}' as varchar(2))

    {% if is_incremental() %}
        where wk.last_update_dt >= '2023-01-01' /*(
            select coalesce(max(dw_record_update_dt), '1900-01-01')
            from {{ this }}
        )*/
    {% endif %}
)

-- =====================================================
-- 3 FINAL SELECT (CONTRACT SAFE)
-- =====================================================

select

        /* ALL COLUMNS EXPLICITLY CAST FOR CONTRACT */

        cast(voucher_sk as varchar(32)) as voucher_sk,
        cast(voucher_id as varchar(10)) as voucher_id,
        cast(business_unit_code_id as varchar(5)) as business_unit_code_id,

        cast(voucher_type_cd as varchar(1)) as voucher_type_cd,
        cast(voucher_type_desc as varchar(40)) as voucher_type_desc,
        cast(voucher_invoice_id as varchar(30)) as voucher_invoice_id,
        cast(voucher_invoice_dt as timestamp) as voucher_invoice_dt,
        cast(purchase_order_id as varchar(10)) as purchase_order_id,
        cast(voucher_source_cd as varchar(4)) as voucher_source_cd,
        cast(voucher_source_desc as varchar(40)) as voucher_source_desc,
        cast(voucher_style_cd as varchar(4)) as voucher_style_cd,
        cast(voucher_style_desc as varchar(40)) as voucher_style_desc,
        cast(origin_cd as varchar(3)) as origin_cd,
        cast(voucher_desc as varchar(254)) as voucher_desc,
        cast(doc_currency_cd as varchar(3)) as doc_currency_cd,

        cast(dept_id as varchar(5)) as dept_id,
        cast(routing_org_node as varchar(6)) as routing_org_node,
        cast(organization_node_level_nbr as smallint) as organization_node_level_nbr,

        cast(source_system_cd as varchar(2)) as source_system_cd,
        cast(source_system_desc as varchar(40)) as source_system_desc,
        cast(source_system_add_dt as timestamp) as source_system_add_dt,
        cast(source_system_modified_dt as timestamp) as source_system_modified_dt,
		cast(source_system_operator_id as varchar(32)) as source_system_operator_id,
        cast(last_dw_updt_session_nm as varchar(60)) as last_dw_updt_session_nm,
        cast(last_dw_updt_session_begin_dt as timestamp) as last_dw_updt_session_begin_dt,
        
        cast(dw_record_insert_dt as timestamp) as dw_record_insert_dt,
        cast(dw_record_insert_id as varchar(32)) as dw_record_insert_id,
        cast(dw_record_update_dt as timestamp) as dw_record_update_dt,
        cast(dw_record_update_id as varchar(32)) as dw_record_update_id,
		
		cast(row_hash as varchar(32)) as row_hash

    from src