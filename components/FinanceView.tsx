import React from "react";
import { AdminFinancials } from "./admin/AdminFinancials";
import { PageTitle } from "./ui/PageTitle";

/**
 * Standalone Finanzen view (Sidebar entry), visible to every role with
 * admin.reports.read (admin, buchhaltung, leitung). Previously the financial
 * dashboard only existed as a tab inside the Admin panel — reachable only for
 * users who could see the Admin menu (user/role management rights). After the
 * roles rework, roles like buchhaltung/leitung had report permission but no
 * path to the report (Incident 2026-07-10: "Finanz-Dashboard verschwunden").
 */
export default function FinanceView() {
  return (
    <div className="space-y-5">
      <PageTitle>Finanzen</PageTitle>
      <AdminFinancials />
    </div>
  );
}
