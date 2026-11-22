/**
 * The shapes the server sends.
 *
 * Collected here rather than declared inline per screen, for a reason beyond
 * tidiness: `tools/check_types.py` compares this file against the C# records
 * and fails the build when they disagree. It has caught a renamed field and a
 * nullability mismatch that would otherwise have rendered as a blank cell —
 * which is the worst kind of failure, because a blank money column looks like
 * a zero rather than an error.
 *
 * That check resumes the moment this file exists. Keep shapes here as screens
 * are wired, and it keeps working.
 */

// --- session ----------------------------------------------------------------

export interface LoginResponse {
  token: string;
  expiresAt: string;
  staffId: string;
  fullName: string;
  role: string;
  siteId: string;
  mustChangePassword: boolean;
  permissions: string[];
}

export interface Session {
  staffId: string;
  name: string;
  role: string;
  siteId: string | null;
  permissions: string[];
}

// --- dashboard --------------------------------------------------------------

export interface SiteOverviewRow {
  /** STATION or DEPOT. */
  kind: string;
  id: string;
  name: string;
  location: string;
  manager: string;

  pumpsTotal: number;
  nozzlesActive: number;
  nozzlesIdle: number;

  lowestTankPct: number | null;
  lowestTankGrade: string | null;

  todayRevenue: number;
  litresDispensed: number;
  alertCount: number;
  criticalAlerts: number;

  /**
   * Null on a manual station.
   *
   * An average transaction needs a per-transaction record, and a station that
   * reads meters by hand produces a shift total instead. Returned as null so
   * the card shows a dash rather than a figure derived from a guess.
   */
  avgTransaction: number | null;
  revenueTarget: number | null;
}

export interface DashboardOverview {
  businessDate: string;
  totalRevenue: number;
  totalLitres: number;
  sitesReporting: number;
  criticalTankAlerts: number;
  pumpsTotal: number;
  pumpsActive: number;
  /** Null on a station's first day — a percentage against nothing is not a comparison. */
  revenueVsYesterdayPct: number | null;
  litresVsYesterdayPct: number | null;
  sites: SiteOverviewRow[];
}

// --- statements -------------------------------------------------------------

export interface StatementMeta {
  key: string;
  title: string;
  purpose: string;
  group: string;
  needsDates: boolean;
}

export interface StatementColumn {
  key: string;
  label: string;
  /** text | figure | money | litres | date | pill */
  kind: string;
}

export interface StatementResult {
  key: string;
  title: string;
  purpose: string;
  from: string | null;
  to: string | null;
  columns: StatementColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
}

// --- inventory --------------------------------------------------------------

export interface TankInventoryRow {
  id: string;
  site: string;
  grade: string;
  gradeCode: string;
  code: string;

  capacityLitres: number;
  safeFill: number;
  deadStock: number;
  currentLitres: number;
  waterLitres: number | null;
  fillPct: number;

  /** normal | low | critical | replenishing */
  status: string;

  /**
   * An AVERAGE, not an instantaneous rate: a fortnight of sales over the hours
   * the station actually traded. A tank selling hard on a Friday afternoon and
   * nothing overnight has the same average as one selling steadily, and only
   * one of them runs dry before morning — so treat this as a planning figure.
   */
  drawRateLph: number | null;
  hoursToEmpty: number | null;

  lastDelivery: string | null;
  lastDipped: string | null;
}

// --- credit -----------------------------------------------------------------

export interface CustomerView {
  id: string;
  code: string;
  name: string;
  contactPhone: string | null;
  creditLimit: number;
  paymentTermsDays: number;
  balance: number;
  headroom: number;
  /** The oldest unsettled invoice. Null when nothing is owed. */
  oldestInvoice: string | null;
  isActive: boolean;
}

// --- people -----------------------------------------------------------------

export interface StaffRow {
  id: string;
  employeeNo: string;
  fullName: string;
  role: string;
  phone: string | null;
  hiredOn: string | null;
  isActive: boolean;
  /**
   * TRUE FOR EVERYONE EXCEPT ATTENDANTS. The schema defines it as
   * role <> 'ATTENDANT': an operator is someone allowed to AUTHOR records
   * (meter readings, dips), which is what the composite foreign keys check.
   *
   * This comment used to say the opposite -- "an operator works a nozzle" --
   * and two screens inverted it as a result. To find attendants, compare the
   * role, not this flag.
   */
  isOperator: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  activeSessions: number;
}

// --- alerts -----------------------------------------------------------------

export interface AlertRow {
  id: string;
  siteId: string;
  siteName: string;
  /** critical | warning | info */
  type: string;
  message: string;
  raisedAt: string;
  /**
   * Always false: this system has no acknowledged state. An exception is open
   * or resolved, and a half-state would let somebody quiet a red row without
   * answering it — which is what an exception log exists to prevent.
   */
  acknowledged: boolean;
}

export interface CustomerLedgerRow {
  id: string;
  customerId: string;
  at: string;
  description: string;
  litres: number;
  /** Negative for a payment — it reduces what is owed. */
  amount: number;
  /** purchase | payment */
  kind: string;
  shift: string;
}

// --- organisation -----------------------------------------------------------

export interface SiteApprovalRow {
  siteId: string;
  code: string;
  name: string;
  kind: string;
  managerCount: number;
  /**
   * False when a site has fewer than two managers. Not a fault — it means
   * head office must approve that site's shifts, and it is far better to know
   * that now than at eleven at night when a shift will not close.
   */
  canSelfApprove: boolean;
  note: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  legalName: string | null;
  registrationNo: string | null;
  countryCode: string;
  baseCurrency: string;
  headOfficeId: string | null;
  headOfficeName: string | null;
  siteCount: number;
  staffCount: number;
  isActive: boolean;
}

// --- dry stock --------------------------------------------------------------

export interface DryItemView {
  itemId: string;
  sku: string;
  name: string;
  category: string;
  sellUnit: string;
  onHand: number;
  reorderLevel: number;
  needsReorder: boolean;
  unitPrice: number | null;
  /** LPG cylinders are tracked full/empty, which ordinary stock is not. */
  isCylinder: boolean;
  cylinderState: string | null;
  /**
   * The other half of a cylinder pair: a full 13kg and its empty counterpart
   * point at each other. An exchange moves one to the other rather than
   * selling stock, which is why a cylinder swap does not reduce the count.
   */
  exchangePairId: string | null;
}

// --- equipment --------------------------------------------------------------

export interface EquipmentRow {
  id: string;
  /** TANK | PUMP | NOZZLE */
  kind: string;
  code: string;
  /** Free text: a tank's product and capacity, a pump's make. */
  detail: string | null;
  /** The pump a nozzle hangs off, or the tank it draws from. */
  parentCode: string | null;
  isActive: boolean;
  /**
   * Whether anything references it. Equipment in use is deactivated, never
   * deleted — a nozzle with meter readings against it must keep existing or
   * those readings lose their subject.
   */
  inUse: boolean;
}

// --- site operations --------------------------------------------------------

export interface NozzleState {
  id: string;
  pumpCode: string;
  nozzleCode: string;
  gradeCode: string;
  gradeName: string;
  /** active (somebody rostered on an open shift) | idle */
  status: string;
  attendantName: string | null;
  todayLitres: number;
  todayRevenue: number;
  lastReadingAt: string | null;
}

export interface SiteOperations {
  siteId: string;
  siteName: string;
  location: string;
  manager: string;
  shiftOpen: boolean;
  shiftLabel: string | null;
  shiftOpenedAt: string | null;
  shiftOpenedBy: string | null;
  todayRevenue: number;
  todayLitres: number;
  nozzles: NozzleState[];
}

// --- catalogue --------------------------------------------------------------

export interface IncomeRow {
  id: string;
  businessDate: string;
  site: string;
  category: string;
  categoryCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** CASH | MOBILE_MONEY | CARD | ACCOUNT */
  settlement: string;
  reference: string | null;
  recordedBy: string;
}

export interface IncomeCategoryRow {
  id: string;
  code: string;
  name: string;
}

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  /** The last EXECUTED price at this site. Null if none has ever been set. */
  pumpPrice: number | null;
  stockLitres: number;
  tankCount: number;
  isActive: boolean;
}

export interface SettingRow {
  key: string;
  category: string;
  label: string;
  description: string;
  value: string;
  kind: string;
}

export interface ChannelRef {
  id: string;
  code: string;
  name: string;
  /** MOBILE_MONEY | CARD | VOUCHER */
  kind: string;
  /** The merchant till an attendant quotes to a customer. */
  tillNumber: string | null;
}

// --- shift closure ----------------------------------------------------------
//
// Named exactly as the C# classes, so check_types.py compares them field by
// field. The close is where money is declared against named people; a renamed
// field here would render as a blank figure on the one screen that must not
// have any.

export interface ShiftSummary {
  id: string;
  businessDate: string;
  label: string;
  segment: number;
  state: string;
  closedReason: string | null;
  openedAt: string;
  closedAt: string | null;
  openedByName: string;
  salesValue: number;
  salesLitres: number;
  openExceptions: number;
}

export interface AssignmentView {
  id: string;
  nozzleId: string;
  nozzleCode: string;
  pumpCode: string;
  productCode: string;
  attendantId: string;
  attendantName: string;
  employeeNo: string;
  state: string;
  /** Carried from the last close. The close is closing minus this. */
  openingTotalizer: number | null;
  closingTotalizer: number | null;
  /** The electronic head (730): its own total; only the litres compare. */
  openingElectronic: number | null;
  closingElectronic: number | null;
  grossLitres: number | null;
  divergenceLitres: number | null;
}

export interface TankView {
  tankId: string;
  code: string;
  productCode: string;
  bookLitres: number;
  actualLitres: number | null;
  varianceLitres: number | null;
  variancePct: number | null;
  withinTolerance: boolean | null;
  nominalLitres: number;
  safeFill: number;
  deadStock: number;
}

export interface CashUpView {
  cashUpId: string;
  staffId: string;
  fullName: string;
  status: string;
  salesValue: number;
  cashDeclared: number;
  electronicDeclared: number;
  creditTotal: number;
  discountTotal: number;
  shortageRaised: number;
  overageRaised: number;
  /** Money the server could not account for. Must be zero, or be a named shortage. */
  /** Short (+) or over (-) against the expected cash. */
  unallocated: number;
  /** Handed in exactly what was owed. */
  isBalanced: boolean;
  // the statement (730): from the meters to the cash in hand
  meteredLitres: number;
  testLitres: number;
  ownUseLitres: number;
  returnedLitres: number;
  soldLitres: number;
  fuelValue: number;
  shopValue: number;
  mobileMoney: number;
  cardAndVouchers: number;
  agreedPrices: number;
  cashDropped: number;
  cashAtClose: number;
  /** fuel + shop - mobile money - card - credit - agreed prices - discounts - drops */
  expectedCash: number;
}

export interface ShiftDetail {
  shift: ShiftSummary;
  assignments: AssignmentView[];
  tanks: TankView[];
  cashUps: CashUpView[];
}

/** close-preview runs the real close and rolls it back. This is its answer. */
export interface PreviewResult {
  shiftId: string;
  meterEvents: number;
  tanksReconciled: number;
  exceptions: number;
  cashUps: CashUpView[];
  tanks: TankView[];
}

export interface CloseResult {
  shiftId: string;
  meterEvents: number;
  tanksReconciled: number;
  cashUps: number;
  exceptions: number;
}

export interface ShiftPriceRow {
  productCode: string;
  unitPrice: number;
}

export interface ReturnToTankRow {
  id: string;
  nozzleId: string;
  nozzleLabel: string;
  litres: number;
  reason: string;
  recordedBy: string;
  witnessedBy: string | null;
  recordedAt: string;
}

export interface ClosureContext {
  prices: ShiftPriceRow[];
  returns: ReturnToTankRow[];
}

// --- shift operations -------------------------------------------------------

export interface ExceptionView {
  /** bigint on the server; carried as a number because it is small and local. */
  id: number;
  entity: string;
  entityId: string;
  code: string;
  level: string;
  detail: string;
  raisedAt: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

// --- admin and operations ---------------------------------------------------

export interface SessionRow {
  id: string;
  fullName: string;
  employeeNo: string;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuditRow {
  /** bigint on the server, carried as a number: it is only ever displayed. */
  id: number;
  actorName: string | null;
  entity: string;
  entityId: string;
  action: string;
  occurredAt: string;
  ipAddress: string | null;
}

export interface PendingPriceView {
  id: string;
  productCode: string;
  oldPrice: number | null;
  newPrice: number;
  /** When it should take effect. The shift is cut at this point, not before. */
  effectiveFrom: string;
  source: string;
  directiveRef: string | null;
}

// --- loss reporting ---------------------------------------------------------

export interface DailyLossRow {
  businessDate: string;
  productCode: string;
  tankCode: string;
  soldLitres: number;
  receivedLitres: number;
  /** What the books say should be in the tank. */
  bookLitres: number;
  /** What the dip found. */
  actualLitres: number;
  /** Book minus actual. Negative means more fuel than expected. */
  lossLitres: number;
  lossPct: number | null;
  lossValue: number;
}

export interface DivergenceRow {
  businessDate: string;
  nozzleLabel: string;
  productCode: string;
  /** The legal figure: what the attendant is billed on. */
  mechanicalLitres: number;
  electronicLitres: number | null;
  divergenceLitres: number | null;
  divergencePct: number | null;
  attendantName: string;
}

// --- analytics ---------------------------------------------------------------

export interface RevenuePoint {
  date: string;
  siteName: string;
  revenue: number;
  litres: number;
}

export interface FuelGradeSlice {
  gradeCode: string;
  gradeName: string;
  litres: number;
  revenue: number;
}

// --- sales during the shift ---------------------------------------------------

export interface CreditSaleView {
  id: string;
  customerName: string;
  plateNo: string | null;
  attendantName: string;
  productCode: string;
  litres: number;
  /** The shift's price for the grade, applied by the server. */
  unitPrice: number;
  amount: number;
  voucherNo: string | null;
  recordedAt: string;
}

export interface DrySaleView {
  id: string;
  /** Who sold it. The close needs a cash-up for everyone who sold. */
  sellerId: string;
  sellerName: string;
  receiptNo: string | null;
  totalAmount: number;
  recordedAt: string;
}

// --- depot ----------------------------------------------------------------

export interface DepotDayRow {
  shiftId: string;
  businessDate: string;
  state: string;
  openedAt: string;
  closedAt: string | null;
  loads: number;
  litresOut: number;
  revenue: number;
  cost: number;
  margin: number;
  loadsBelowCost: number;
  transfersOut: number;
  transferLitres: number;
  deliveriesIn: number;
  deliveredLitres: number;
}

export interface BulkSaleRow {
  id: string;
  invoiceNo: string;
  truckReg: string;
  driverName: string | null;
  destination: string | null;
  customerName: string;
  productCode: string;
  tankCode: string;
  litres: number;
  meteredLitres: number | null;
  dippedLitres: number | null;
  /** METER or DIP: which figure the customer is billed on. */
  basis: string;
  unitPrice: number;
  /** What the fuel cost, carried with the sale so a loss is visible. */
  unitCost: number | null;
  amount: number;
  paymentTerms: string;
  loadedAt: string;
  recordedByName: string;
}

export interface TransferRow {
  id: string;
  reference: string;
  fromSite: string;
  fromTank: string;
  toSite: string;
  toTank: string;
  productCode: string;
  litres: number;
  unitCost: number;
  value: number;
  truckReg: string | null;
  movedAt: string;
  recordedByName: string;
}

export interface BelowCostRow {
  id: string;
  invoiceNo: string;
  truckReg: string;
  customerName: string;
  productCode: string;
  loadedAt: string;
  litres: number;
  unitPrice: number;
  unitCost: number;
  marginPerLitre: number;
  margin: number;
}

// --- stock counts ---------------------------------------------------------

export interface StockCountLine {
  tankId: string;
  tankCode: string;
  productCode: string;
  /** What the ledger says is in the tank at the moment of counting. */
  bookLitres: number;
  countedLitres: number;
  /** Counted minus book. */
  varianceLitres: number;
  varianceReason: string | null;
}

export interface DryCountLineView {
  itemId: string;
  sku: string;
  name: string;
  bookQty: number;
  countedQty: number;
  varianceQty: number;
  varianceReason: string | null;
}

// --- suppliers and the profit statement ----------------------------------------

export interface SupplierBalanceRow {
  supplierId: string;
  code: string;
  name: string;
  billed: number;
  paid: number;
  /** Billed minus paid: what is still owed to them. */
  balance: number;
  oldestInvoice: string | null;
  earliestDue: string | null;
  overdue: boolean;
}

export interface DeliveryView {
  id: string;
  deliveryNoteNo: string;
  supplierName: string | null;
  truckReg: string | null;
  status: string;
  sealsIntact: boolean | null;
  arrivedAt: string | null;
  settleUntil: string | null;
  /** What the note says was loaded. */
  loadedLitres: number;
  /** What the dips say arrived. */
  receivedLitres: number | null;
  /** Received minus loaded. Negative is fuel lost between depot and tank. */
  transitVariance: number | null;
}

export interface CategoryTotal {
  category: string;
  amount: number;
  fromTill: number;
  entries: number;
}

export interface ProfitStatement {
  from: string;
  to: string;
  fuelRevenue: number;
  fuelCost: number;
  fuelMargin: number;
  shopRevenue: number;
  shopCost: number;
  shopMargin: number;
  grossMargin: number;
  expenses: number;
  expensesFromTill: number;
  stockLossValue: number;
  shortagesRaised: number;
  shortagesRecovered: number;
  discountsGiven: number;
  ownUseLitres: number;
  ownUseCost: number;
  netPosition: number;
  expenseBreakdown: CategoryTotal[];
  /** Fuel paid for on the note and never received, at the invoice price. */
  transitLossValue: number;
  /** Litres sold whose cost is unknown: counted apart, NOT costed at 0 (540). */
  uncostedFuelLitres: number;
}

// --- credit ageing and statements ---------------------------------------------

export interface AgeingRow {
  customerId: string;
  code: string;
  name: string;
  creditLimit: number;
  paymentTermsDays: number;
  balance: number;
  current30: number;
  days31To60: number;
  days61To90: number;
  over90: number;
  oldestDays: number | null;
  /** Owed beyond the customer's own agreed terms. */
  pastTerms: number;
  headroom: number;
  isActive: boolean;
  /** Paid beyond everything billed: money on account. */
  unappliedCredit: number;
}

export interface StatementLineRow {
  at: string;
  kind: string;
  reference: string;
  vehicle: string | null;
  litres: number | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

// --- management reports --------------------------------------------------------

export interface SiteLine {
  siteName: string;
  siteKind: string;
  litres: number;
  revenue: number;
  margin: number;
  marginPerLitre: number | null;
}
export interface ApprovalItem {
  kind: string;
  description: string;
  amount: number | null;
  since: string;
  ageDays: number;
}
export interface ConcentrationRow {
  name: string;
  balance: number;
  sharePct: number;
  oldestDays: number | null;
  overdue: boolean;
}

export interface DirectorsSummary {
  from: string;
  to: string;
  revenue: number;
  grossMargin: number;
  netPosition: number;
  marginPerLitre: number;
  totalLitres: number;
  stockLossLitres: number;
  stockLossValue: number;
  stockLossPct: number | null;
  receivables: number;
  receivablesPastTerms: number;
  payables: number;
  payablesOverdue: number;
  cashOnHand: number;
  workingCapital: number;
  openExceptions: number;
  criticalExceptions: number;
  loadsBelowCost: number;
  belowCostValue: number;
  sites: SiteLine[];
  awaiting: ApprovalItem[];
  concentration: ConcentrationRow[];
}

export interface LossSummary {
  productCode: string;
  totalSold: number;
  totalLoss: number;
  totalLossValue: number;
  lossPct: number | null;
  daysWithLoss: number;
  daysMeasured: number;
  worstDayLitres: number;
  worstDate: string | null;
  /** The company's monthly loss tolerance, % of litres sold. */
  tolerancePct: number | null;
  /** This period lost more than the tolerance allows. */
  overTolerance: boolean;
}
export interface CumulativeLossRow {
  businessDate: string;
  productCode: string;
  dayLossLitres: number;
  dayLossValue: number;
  daySoldLitres: number;
  cumulativeLossLitres: number;
  cumulativeLossValue: number;
  cumulativeSoldLitres: number;
  cumulativeLossPct: number | null;
}
export interface AttendantScoreRow {
  staffId: string;
  fullName: string;
  shifts: number;
  litresSold: number;
  salesValue: number;
  shortagesRaised: number;
  shortageRate: number;
  exceptionsAgainst: number;
}
export interface StockCardRow {
  movementId: number;
  occurredAt: string;
  kind: string;
  signedLitres: number;
  runningLitres: number;
  tankCode: string;
  productCode: string;
}
export interface SitePerformanceRow {
  siteId: string;
  siteCode: string;
  siteName: string;
  siteKind: string;
  businessDate: string;
  retailLitres: number;
  retailRevenue: number;
  retailCost: number;
  bulkLitres: number;
  bulkRevenue: number;
  bulkCost: number;
  revenue: number;
  cost: number;
  margin: number;
}
export interface DutyPeriodRow {
  businessDate: string;
  label: string;
  segments: number;
  startedAt: string;
  endedAt: string | null;
  fullySignedOff: boolean;
  firstShiftId: string | null;
  /** Every shift in the duty period, in order. */
  shiftIds: string[];
  /** Why each segment was cut: a price change, a handover. */
  cutReasons: string[] | null;
}
/**
 * One shift's measured sales on a business date. Sales are known per shift --
 * meters are read at close -- so this is the finest honest breakdown.
 */
export interface ShiftSalesPoint {
  shiftId: string;
  label: string;
  segment: number;
  state: string;
  openedAt: string;
  closedAt: string | null;
  litres: number;
  revenue: number;
}

// --- administration -----------------------------------------------------------

/** The trading policy: every tolerance the variance checks read. */
export interface PolicyRow {
  shiftVariancePct: number;
  shiftVarianceLitres: number;
  monthlyVariancePct: number;
  dipAgreementMm: number;
  waterAlarmMm: number;
  waterAlarmLitres: number;
  allowDipAboveChart: boolean;
  meterDivergencePct: number;
  pumpTestTolerancePct: number;
  transitLossPct: number;
  postDecantSettleMin: number;
  cashVarianceAlert: number;
  /** Most cash an attendant should carry between drops (580/590); 0 = off. */
  attendantCashCap: number | null;   // nullable on save: left out, the setting stays
  /** A stock variance this small is dipstick noise and is not raised (590). */
  dipNoiseLitres: number | null;
  maxShortageCarry: number;
  requireSecondApproverAbove: number;
  breakShiftOnPriceChange: boolean;
  allowCreditSales: boolean;
  evidenceGraceHours: number;
}

// --- equipment, as the save accepts it (and load-for-edit returns it) ---------

export interface UpsertTank {
  code: string;
  productId: string;
  nominalLitres: number;
  safeFill: number;
  deadStock: number;
  maxDipMm: number;
}

export interface UpsertPump {
  code: string;
  make: string | null;
  serialNo: string | null;
}

export interface UpsertNozzle {
  code: string;
  pumpId: string;
  tankId: string;
  integerDigits: number;
  maxFlowLpm: number;
}

// --- cash position, shift detail, rosters ----------------------------------------

export interface CashPositionView {
  businessDate: string;
  cashCollected: number;
  cashBanked: number;
  /** That day's collected minus that day's banked. Negative on a day that banked earlier cash. */
  onHand: number;
  /** Cash in the station at the end of this day, over all history. The figure to read. */
  runningOnHand: number;
}

export interface ActivityItem {
  kind: string;
  description: string;
  litres: number | null;
  amount: number | null;
  recordedBy: string;
  at: string;
}

export interface ShiftActivity {
  pumpTests: number;
  pumpTestLitres: number;
  ownUseDraws: number;
  ownUseLitres: number;
  creditSales: number;
  creditValue: number;
  drySales: number;
  dryValue: number;
  handovers: number;
  items: ActivityItem[];
}

export interface AttendantTenderRow {
  cashUpId: string;
  attendantName: string;
  employeeNo: string;
  settlement: string;
  channelCode: string | null;
  channelName: string | null;
  tillNumber: string | null;
  amount: number;
  reference: string | null;
}

export interface RosterTemplateLine {
  nozzleId: string;
  nozzleCode: string;
  pumpCode: string;
  attendantId: string;
  attendantName: string;
}

export interface RosterTemplateView {
  id: string;
  name: string;
  label: string | null;
  lines: RosterTemplateLine[];
}

/** A closed shift with its money and tank variance -- the shift report, in one query. */
export interface ShiftReportRow {
  id: string;
  businessDate: string;
  label: string;
  state: string;
  openedByName: string;
  siteName: string;
  /** Fuel sold, as charged to the attendants: each line rounded. */
  salesValue: number;
  salesLitres: number;
  /** Shop and lubricant sales, charged to their sellers. */
  shopValue: number;
  openExceptions: number;
  cashDeclared: number;
  electronicDeclared: number;
  creditTotal: number;
  /** Credit at an agreed price: the pump value less what the customer owes. */
  priceAgreementTotal: number;
  discountTotal: number;
  shortageRaised: number;
  /** fuel + shop = cash + electronic + credit + agreed-price + discounts + shortage - overage */
  overageRaised: number;
  /** Closing dip minus book as at the close. Negative is fuel missing. */
  varianceLitres: number;
  /** The variance at each tank's average cost. */
  varianceValue: number;
}

// --- cash drops (580) ---------------------------------------------------------

export interface CashDropRow {
  id: string;
  seqNo: number;
  attendantId: string;
  attendant: string;
  amount: number;
  witness: string;
  bookRef: string | null;
  droppedAt: string;
  recordedBy: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface CashDropTotal {
  attendantId: string;
  dropped: number;
  drops: number;
}

export interface DropWitness {
  id: string;
  fullName: string;
  role: string;
}

/** GET /api/shifts/{id}/cash-drops */
export interface CashDropList {
  cap: number;
  drops: CashDropRow[];
  byAttendant: CashDropTotal[];
  witnesses: DropWitness[];
}

// --- agreed customer prices (600) -------------------------------------------

/** GET /api/credit/customers/{id}/prices */
export interface CustomerPriceRow {
  id: string;
  productId: string;
  product: string;
  /** A fixed agreed price, or null for a margin. */
  price: number | null;
  /** Per litre on the pump price, or null for a fixed price. */
  margin: number | null;
  validFrom: string;
  validTo: string | null;
  reason: string;
  authorisedBy: string;
  inForce: boolean;
}

// --- the books (610/620) -----------------------------------------------------

export interface LedgerLine {
  postingDate: string | null;
  eventAt: string | null;
  journalId: string | null;
  source: string;
  memo: string;
  party: string | null;
  qty: number | null;
  debit: number | null;
  credit: number | null;
  balance: number;
}
export interface ReceivableRow {
  customerId: string;
  code: string;
  name: string;
  creditLimit: number;
  billed: number;
  paid: number;
  subledger: number;
  ledger: number;
  difference: number;
  /** Credit sales on shifts still open: on the account, not yet in the books. */
  inOpenShifts: number;
  current0To30: number;
  days31To60: number;
  days61To90: number;
  over90: number;
  lastPayment: string | null;
  oldestUnpaid: string | null;
}
export interface ControlRow {
  control: string;
  detail: string;
  ledger: number;
  record: number | null;
  difference: number | null;
  unit: string;
  /** true agrees, false differs, null for information */
  ok: boolean | null;
}
export interface JournalRow {
  id: string;
  postingDate: string;
  eventAt: string;
  source: string;
  memo: string;
  total: number;
  reversesId: string | null;
  reversed: boolean;
  postedBy: string | null;
}
export interface JournalLineRow {
  code: string;
  account: string;
  debit: number | null;
  credit: number | null;
  qty: number | null;
  party: string | null;
  memo: string | null;
}
export interface AccountRow {
  code: string;
  name: string;
  type: string;
  control: string | null;
}
export interface StatementLine {
  code: string;
  name: string;
  amount: number;
}
export interface ProfitAndLoss {
  from: string;
  to: string;
  income: StatementLine[];
  totalIncome: number;
  costOfSales: StatementLine[];
  grossProfit: number;
  expenses: StatementLine[];
  totalExpenses: number;
  netProfit: number;
}

// --- bank and mobile money (630) ---------------------------------------------

export interface MoneyAccountRow {
  id: string;
  kind: string;
  name: string;
  institution: string;
  accountRef: string | null;
  channelCode: string | null;
  isDefault: boolean;
  bookBalance: number;
  lastStatement: string | null;
}
export interface BankRecSummary {
  statementBalance: number;
  statementDate: string | null;
  inTransit: number;
  notPresented: number;
  statementOnly: number;
  bookBalance: number;
  difference: number;
  unmatchedBook: number;
  unmatchedStatement: number;
  staleBook: number;
}
export interface BankRecItem {
  side: string;
  id: string;
  onDate: string;
  amount: number;
  description: string | null;
  reference: string | null;
}
export interface BankReconciliation {
  summary: BankRecSummary;
  items: BankRecItem[];
}
