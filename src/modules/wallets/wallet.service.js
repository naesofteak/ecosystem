
const mongoose = require("mongoose");

const Wallet = require("./wallet.model");
const WalletTransaction = require("./wallet-transaction.model");

const MAIN_PERCENTAGE = 60;
const MASTER_PERCENTAGE = 40;
const MICRO_USDT = 1_000_000;

const WALLET_TYPES = ["main", "master"];

const TRANSACTION_TYPES = ["credit", "debit"];

const CATEGORIES = [
  "activation_fee",
  "commission",
  "pairing_reward",
  "withdrawal",
  "refund",
  "wallet_transfer",
  "admin_adjustment",
  "deposit",
  "other"
];

class WalletError extends Error {
  constructor(message, code = "WALLET_ERROR") {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

// --------------------------------------------------
// AMOUNT UTILITIES
// --------------------------------------------------

function validateAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new WalletError(
      "Amount must be a positive integer in micro-USDT.",
      "INVALID_AMOUNT"
    );
  }

  return amount;
}

function usdtToMicro(amount) {
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new WalletError(
      "Invalid USDT amount.",
      "INVALID_AMOUNT"
    );
  }

  const scaled = amount * MICRO_USDT;
  const micro = Math.round(scaled);

  if (
    !Number.isSafeInteger(micro) ||
    Math.abs(scaled - micro) > 0.000001
  ) {
    throw new WalletError(
      "USDT supports a maximum of 6 decimal places.",
      "INVALID_AMOUNT"
    );
  }

  return micro;
}

function microToUsdt(amount) {
  return amount / MICRO_USDT;
}

// --------------------------------------------------
// INCOME DISTRIBUTION
// --------------------------------------------------

function splitIncome(amount) {
  validateAmount(amount);

  // Avoid multiplying a potentially large integer
  // directly by 60.
  const mainAmount =
    Math.floor(amount / 100) * MAIN_PERCENTAGE +
    Math.floor(
      ((amount % 100) * MAIN_PERCENTAGE) / 100
    );

  const masterAmount = amount - mainAmount;

  return {
    mainAmount,
    masterAmount
  };
}

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

function validateUserId(userId) {
  if (!mongoose.isValidObjectId(userId)) {
    throw new WalletError(
      "Invalid user ID.",
      "INVALID_USER"
    );
  }
}

function validateOperationId(operationId) {
  if (
    typeof operationId !== "string" ||
    !operationId.trim() ||
    operationId.length > 150
  ) {
    throw new WalletError(
      "A stable operation ID is required.",
      "INVALID_OPERATION_ID"
    );
  }

  return operationId.trim();
}

function validateWalletType(walletType) {
  if (!WALLET_TYPES.includes(walletType)) {
    throw new WalletError(
      "Invalid wallet type.",
      "INVALID_WALLET_TYPE"
    );
  }
}

function validateCategory(category) {
  if (!CATEGORIES.includes(category)) {
    throw new WalletError(
      "Invalid transaction category.",
      "INVALID_CATEGORY"
    );
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new WalletError(
      "At least one wallet entry is required.",
      "INVALID_ENTRIES"
    );
  }

  const usedWalletTypes = new Set();

  for (const entry of entries) {
    validateWalletType(entry.walletType);

    if (!TRANSACTION_TYPES.includes(entry.transactionType)) {
      throw new WalletError(
        "Invalid transaction type.",
        "INVALID_TRANSACTION_TYPE"
      );
    }

    validateAmount(entry.amount);

    if (usedWalletTypes.has(entry.walletType)) {
      throw new WalletError(
        "An operation cannot contain duplicate entries for the same wallet.",
        "DUPLICATE_WALLET_ENTRY"
      );
    }

    usedWalletTypes.add(entry.walletType);
  }
}

function makeIdempotencyKey(operationId, walletType) {
  return `${operationId}:${walletType}`;
}

function getBalanceField(walletType) {
  return walletType === "main"
    ? "mainBalance"
    : "masterBalance";
}

// --------------------------------------------------
// WALLET CREATION
// --------------------------------------------------

async function createWallet(userId) {
  validateUserId(userId);

  try {
    const wallet = await Wallet.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          currency: "USDT",
          mainBalance: 0,
          masterBalance: 0,
          version: 0,
          operationLockId: null,
          operationLockAt: null,
          status: "active"
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true
      }
    );

    if (!wallet) {
      throw new WalletError(
        "Unable to create wallet.",
        "WALLET_CREATION_FAILED"
      );
    }

    return wallet;
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Wallet.findOne({ userId });

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
}

// --------------------------------------------------
// WALLET LOCKING
// --------------------------------------------------

async function acquireWalletLock(walletId, operationId) {
  // No automatic expired-lock takeover.
  // A lock must be explicitly recovered.
  const wallet = await Wallet.findOneAndUpdate(
    {
      _id: walletId,
      status: "active",
      $or: [
        { operationLockId: null },
        { operationLockId: { $exists: false } }
      ]
    },
    {
      $set: {
        operationLockId: operationId,
        operationLockAt: new Date()
      }
    },
    {
      new: true
    }
  );

  if (!wallet) {
    throw new WalletError(
      "Wallet is locked or unavailable. Recovery or investigation is required.",
      "WALLET_LOCKED"
    );
  }

  return wallet;
}

async function releaseWalletLock(walletId, operationId) {
  const result = await Wallet.updateOne(
    {
      _id: walletId,
      operationLockId: operationId
    },
    {
      $set: {
        operationLockId: null,
        operationLockAt: null
      }
    }
  );

  return result.modifiedCount === 1;
}

// --------------------------------------------------
// TRANSACTION LOOKUP
// --------------------------------------------------

async function getExistingOperation(operationId) {
  return WalletTransaction.find({
    operationId
  })
    .sort({ walletType: 1 })
    .lean();
}

function verifyExistingOperation({
  transactions,
  userId,
  walletId,
  entries,
  category
}) {
  if (!transactions.length) {
    return false;
  }

  const expected = new Map(
    entries.map((entry) => [
      entry.walletType,
      entry
    ])
  );

  for (const transaction of transactions) {
    const entry = expected.get(transaction.walletType);

    if (
      transaction.userId.toString() !== userId.toString() ||
      transaction.walletId.toString() !== walletId.toString() ||
      !entry ||
      transaction.amount !== entry.amount ||
      transaction.transactionType !== entry.transactionType ||
      transaction.category !== category
    ) {
      throw new WalletError(
        "Operation ID already exists with different transaction details.",
        "IDEMPOTENCY_CONFLICT"
      );
    }

    expected.delete(transaction.walletType);
  }

  if (expected.size !== 0) {
    throw new WalletError(
      "Operation has incomplete ledger entries and requires recovery.",
      "OPERATION_INCOMPLETE"
    );
  }

  if (transactions.every((item) => item.status === "completed")) {
    return true;
  }

  throw new WalletError(
    "Operation already exists and requires recovery.",
    "OPERATION_REQUIRES_RECOVERY"
  );
}

// --------------------------------------------------
// BALANCE CALCULATION
// --------------------------------------------------

function calculateNewBalances(wallet, entries) {
  const changes = {
    mainBalance: wallet.mainBalance,
    masterBalance: wallet.masterBalance
  };

  const ledgerEntries = [];

  for (const entry of entries) {
    const field = getBalanceField(entry.walletType);

    const balanceBefore = changes[field];

    const balanceAfter =
      entry.transactionType === "credit"
        ? balanceBefore + entry.amount
        : balanceBefore - entry.amount;

    if (
      !Number.isSafeInteger(balanceAfter) ||
      balanceAfter < 0
    ) {
      throw new WalletError(
        "Insufficient balance or unsafe balance.",
        "INSUFFICIENT_BALANCE"
      );
    }

    changes[field] = balanceAfter;

    ledgerEntries.push({
      walletId: wallet._id,
      userId: wallet.userId,
      walletType: entry.walletType,
      transactionType: entry.transactionType,
      category: entry.category,
      amount: entry.amount,
      balanceBefore,
      balanceAfter,
      currency: "USDT",
      referenceType: entry.referenceType || null,
      referenceId: entry.referenceId || null,
      idempotencyKey: entry.idempotencyKey,
      operationId: entry.operationId,
      status: "pending",
      description: entry.description || "",
      metadata: entry.metadata || {},
      createdBy: entry.createdBy || null
    });
  }

  return {
    changes,
    ledgerEntries
  };
}

// --------------------------------------------------
// CORE WALLET OPERATION
// --------------------------------------------------

async function performOperation({
  userId,
  operationId,
  category,
  entries,
  referenceType = null,
  referenceId = null,
  description = "",
  createdBy = null,
  metadata = {}
}) {
  validateUserId(userId);

  operationId = validateOperationId(operationId);
  validateCategory(category);

  if (
    typeof description !== "string" ||
    description.length > 500
  ) {
    throw new WalletError(
      "Invalid transaction description.",
      "INVALID_DESCRIPTION"
    );
  }

  validateEntries(entries);

  const wallet = await createWallet(userId);

  const preparedEntries = entries.map((entry) => ({
    ...entry,
    category,
    operationId,
    referenceType,
    referenceId,
    description,
    metadata,
    createdBy,
    idempotencyKey: makeIdempotencyKey(
      operationId,
      entry.walletType
    )
  }));

  // Check duplicate operation before locking.
  const existing = await getExistingOperation(operationId);

  if (existing.length) {
    const duplicate = verifyExistingOperation({
      transactions: existing,
      userId: wallet.userId,
      walletId: wallet._id,
      entries: preparedEntries,
      category
    });

    if (duplicate) {
      return {
        success: true,
        duplicate: true,
        operationId
      };
    }
  }

  await acquireWalletLock(wallet._id, operationId);

  let ledgerStarted = false;
  let balanceUpdateConfirmed = false;

  try {
    const currentWallet = await Wallet.findOne({
      _id: wallet._id,
      operationLockId: operationId,
      status: "active"
    });

    if (!currentWallet) {
      throw new WalletError(
        "Wallet lock could not be verified.",
        "LOCK_VERIFICATION_FAILED"
      );
    }

    const {
      changes,
      ledgerEntries
    } = calculateNewBalances(
      currentWallet,
      preparedEntries
    );

    // Insert the pending ledger entries before
    // changing the wallet balance.
    await WalletTransaction.insertMany(
      ledgerEntries,
      {
        ordered: true
      }
    );

    ledgerStarted = true;

    // Update both wallet balances in one atomic
    // single-document operation.
    const update = await Wallet.updateOne(
      {
        _id: currentWallet._id,
        version: currentWallet.version,
        operationLockId: operationId,
        mainBalance: currentWallet.mainBalance,
        masterBalance: currentWallet.masterBalance,
        status: "active"
      },
      {
        $set: {
          mainBalance: changes.mainBalance,
          masterBalance: changes.masterBalance
        },
        $inc: {
          version: 1
        }
      }
    );

    if (update.modifiedCount !== 1) {
      throw new WalletError(
        "Wallet balance update was not confirmed.",
        "BALANCE_UPDATE_FAILED"
      );
    }

    balanceUpdateConfirmed = true;

    // Complete all ledger entries.
    const completion = await WalletTransaction.updateMany(
      {
        operationId,
        walletId: currentWallet._id,
        status: "pending"
      },
      {
        $set: {
          status: "completed",
          completedAt: new Date()
        }
      }
    );

    if (
      completion.modifiedCount !== ledgerEntries.length
    ) {
      throw new WalletError(
        "Wallet balance updated, but ledger completion requires recovery.",
        "LEDGER_COMPLETION_REQUIRED"
      );
    }

    await releaseWalletLock(
      currentWallet._id,
      operationId
    );

    return {
      success: true,
      duplicate: false,
      operationId,
      balances: {
        main: microToUsdt(changes.mainBalance),
        master: microToUsdt(changes.masterBalance),
        total: microToUsdt(
          changes.mainBalance + changes.masterBalance
        )
      }
    };
  } catch (error) {
    // If ledger creation began, preserve the lock.
    // Never automatically assume that the balance
    // update did not happen after a database error.
    if (!ledgerStarted && !balanceUpdateConfirmed) {
      await releaseWalletLock(
        wallet._id,
        operationId
      );
    }

    throw error;
  }
}

// --------------------------------------------------
// INCOME CREDIT: 60% / 40%
// --------------------------------------------------

async function creditIncome({
  userId,
  amount,
  category,
  operationId,
  referenceType = null,
  referenceId = null,
  description = "",
  createdBy = null,
  metadata = {}
}) {
  validateAmount(amount);

  if (
    !["commission", "pairing_reward"].includes(category)
  ) {
    throw new WalletError(
      "Income distribution is only available for commission and pairing rewards.",
      "INVALID_INCOME_CATEGORY"
    );
  }

  const split = splitIncome(amount);

  const entries = [];

  // Skip zero-value entries for very small amounts.
  if (split.mainAmount > 0) {
    entries.push({
      walletType: "main",
      transactionType: "credit",
      amount: split.mainAmount
    });
  }

  if (split.masterAmount > 0) {
    entries.push({
      walletType: "master",
      transactionType: "credit",
      amount: split.masterAmount
    });
  }

  return performOperation({
    userId,
    operationId,
    category,
    referenceType,
    referenceId,
    description,
    createdBy,
    metadata,
    entries
  });
}

// --------------------------------------------------
// CREDIT SPECIFIC WALLET
// --------------------------------------------------

async function creditWallet({
  userId,
  walletType,
  amount,
  category = "deposit",
  operationId,
  referenceType = null,
  referenceId = null,
  description = "",
  createdBy = null,
  metadata = {}
}) {
  validateWalletType(walletType);
  validateAmount(amount);

  return performOperation({
    userId,
    operationId,
    category,
    referenceType,
    referenceId,
    description,
    createdBy,
    metadata,
    entries: [
      {
        walletType,
        transactionType: "credit",
        amount
      }
    ]
  });
}

// --------------------------------------------------
// DEBIT SPECIFIC WALLET
// --------------------------------------------------

async function debitWallet({
  userId,
  walletType,
  amount,
  category,
  operationId,
  referenceType = null,
  referenceId = null,
  description = "",
  createdBy = null,
  metadata = {}
}) {
  validateWalletType(walletType);
  validateAmount(amount);

  return performOperation({
    userId,
    operationId,
    category,
    referenceType,
    referenceId,
    description,
    createdBy,
    metadata,
    entries: [
      {
        walletType,
        transactionType: "debit",
        amount
      }
    ]
  });
}

// --------------------------------------------------
// TRANSFER BETWEEN MAIN AND MASTER
// --------------------------------------------------

async function transferWallet({
  userId,
  fromWallet,
  toWallet,
  amount,
  operationId,
  description = "",
  createdBy = null,
  metadata = {}
}) {
  validateWalletType(fromWallet);
  validateWalletType(toWallet);
  validateAmount(amount);

  if (fromWallet === toWallet) {
    throw new WalletError(
      "Source and destination wallets must be different.",
      "INVALID_TRANSFER"
    );
  }

  return performOperation({
    userId,
    operationId,
    category: "wallet_transfer",
    description,
    createdBy,
    metadata,
    entries: [
      {
        walletType: fromWallet,
        transactionType: "debit",
        amount
      },
      {
        walletType: toWallet,
        transactionType: "credit",
        amount
      }
    ]
  });
}

// --------------------------------------------------
// RECOVER INTERRUPTED OPERATION
// --------------------------------------------------

async function recoverOperation({
  userId,
  operationId
}) {
  validateUserId(userId);
  operationId = validateOperationId(operationId);

  const wallet = await Wallet.findOne({ userId });

  if (!wallet) {
    throw new WalletError(
      "Wallet not found.",
      "WALLET_NOT_FOUND"
    );
  }

  // Recovery can only proceed when the original
  // operation still owns the wallet lock.
  if (wallet.operationLockId !== operationId) {
    throw new WalletError(
      "This operation does not own the wallet lock.",
      "RECOVERY_LOCK_MISMATCH"
    );
  }

  const transactions = await WalletTransaction.find({
    walletId: wallet._id,
    userId,
    operationId
  }).lean();

  if (!transactions.length) {
    // No ledger entries exist. The balance operation
    // was not started.
    await releaseWalletLock(wallet._id, operationId);

    return {
      success: true,
      recovered: true,
      outcome: "no_transaction_found"
    };
  }

  if (
    transactions.some(
      (transaction) => transaction.status === "failed"
    )
  ) {
    throw new WalletError(
      "Failed ledger entries require manual review.",
      "MANUAL_REVIEW_REQUIRED"
    );
  }

  const byWalletType = {};

  for (const transaction of transactions) {
    if (byWalletType[transaction.walletType]) {
      throw new WalletError(
        "Duplicate wallet entries found for this operation.",
        "DUPLICATE_LEDGER_ENTRIES"
      );
    }

    byWalletType[transaction.walletType] = transaction;
  }

  let matchesBefore = true;
  let matchesAfter = true;

  for (const transaction of transactions) {
    const field = getBalanceField(transaction.walletType);

    if (
      wallet[field] !== transaction.balanceBefore
    ) {
      matchesBefore = false;
    }

    if (
      wallet[field] !== transaction.balanceAfter
    ) {
      matchesAfter = false;
    }
  }

  // Wallet update completed but ledger completion
  // did not finish.
  if (matchesAfter) {
    const result = await WalletTransaction.updateMany(
      {
        walletId: wallet._id,
        operationId,
        status: "pending"
      },
      {
        $set: {
          status: "completed",
          completedAt: new Date()
        }
      }
    );

    const remaining = await WalletTransaction.countDocuments({
      walletId: wallet._id,
      operationId,
      status: "pending"
    });

    if (remaining > 0) {
      throw new WalletError(
        "Ledger recovery is incomplete.",
        "RECOVERY_INCOMPLETE"
      );
    }

    await releaseWalletLock(wallet._id, operationId);

    return {
      success: true,
      recovered: true,
      outcome: "completed"
    };
  }

  // Ledger was written, but wallet balance was
  // not changed.
  if (matchesBefore) {
    await WalletTransaction.updateMany(
      {
        walletId: wallet._id,
        operationId,
        status: "pending"
      },
      {
        $set: {
          status: "failed"
        }
      }
    );

    await releaseWalletLock(wallet._id, operationId);

    return {
      success: true,
      recovered: true,
      outcome: "failed_without_balance_change"
    };
  }

  // Never guess when balances are inconsistent.
  throw new WalletError(
    "Wallet balances do not match the transaction ledger. Manual reconciliation is required.",
    "WALLET_RECONCILIATION_REQUIRED"
  );
}

// --------------------------------------------------
// WALLET BALANCE
// --------------------------------------------------

async function getWallet(userId) {
  validateUserId(userId);

  const wallet = await Wallet.findOne({ userId }).lean();

  if (!wallet) {
    return {
      mainBalance: 0,
      masterBalance: 0,
      totalBalance: 0,
      currency: "USDT",
      status: "active"
    };
  }

  return {
    mainBalance: microToUsdt(wallet.mainBalance),
    masterBalance: microToUsdt(wallet.masterBalance),
    totalBalance: microToUsdt(
      wallet.mainBalance + wallet.masterBalance
    ),
    currency: wallet.currency,
    status: wallet.status,
    isOperationLocked: Boolean(wallet.operationLockId)
  };
}

// --------------------------------------------------
// TRANSACTION HISTORY
// --------------------------------------------------

async function getTransactions(
  userId,
  page = 1,
  limit = 20
) {
  validateUserId(userId);

  page = Math.max(1, Number(page) || 1);
  limit = Math.min(
    100,
    Math.max(1, Number(limit) || 20)
  );

  const filter = {
    userId,
    status: "completed"
  };

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),

    WalletTransaction.countDocuments(filter)
  ]);

  return {
    transactions: transactions.map((item) => ({
      ...item,
      amount: microToUsdt(item.amount),
      balanceBefore: microToUsdt(item.balanceBefore),
      balanceAfter: microToUsdt(item.balanceAfter)
    })),

    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  WalletError,

  MICRO_USDT,

  usdtToMicro,
  microToUsdt,
  splitIncome,

  createWallet,

  creditIncome,
  creditWallet,
  debitWallet,
  transferWallet,

  recoverOperation,

  getWallet,
  getTransactions
};
