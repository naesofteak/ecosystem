
const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    walletType: {
      type: String,
      enum: ["main", "master"],
      required: true
    },

    transactionType: {
      type: String,
      enum: ["credit", "debit"],
      required: true
    },

    category: {
      type: String,
      enum: [
        "activation_fee",
        "commission",
        "pairing_reward",
        "withdrawal",
        "refund",
        "wallet_transfer",
        "admin_adjustment",
        "deposit",
        "other"
      ],
      required: true
    },

    // Positive integer amount in micro-USDT.
    // 1 USDT = 1,000,000 micro-USDT.
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Transaction amount must be a safe integer."
      }
    },

    balanceBefore: {
      type: Number,
      required: true,
      min: 0
    },

    balanceAfter: {
      type: Number,
      required: true,
      min: 0
    },

    currency: {
      type: String,
      enum: ["USDT"],
      default: "USDT",
      immutable: true
    },

    referenceType: {
      type: String,
      default: null,
      trim: true
    },

    referenceId: {
      type: String,
      default: null,
      trim: true
    },

    // Unique key prevents duplicate transaction processing.
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true
    },

    // Connects multiple ledger entries from one operation.
    operationId: {
      type: String,
      required: true,
      index: true,
      immutable: true
    },

    relatedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null
    },

    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    completedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Transaction history indexes.
walletTransactionSchema.index({
  userId: 1,
  createdAt: -1
});

walletTransactionSchema.index({
  walletId: 1,
  createdAt: -1
});

walletTransactionSchema.index({
  operationId: 1,
  status: 1
});

// Validate balance calculation.
walletTransactionSchema.pre("validate", function () {
  if (
    !Number.isSafeInteger(this.amount) ||
    this.amount <= 0
  ) {
    throw new Error("Invalid transaction amount.");
  }

  if (
    !Number.isSafeInteger(this.balanceBefore) ||
    !Number.isSafeInteger(this.balanceAfter) ||
    this.balanceBefore < 0 ||
    this.balanceAfter < 0
  ) {
    throw new Error("Invalid transaction balance.");
  }

  const expectedBalance =
    this.transactionType === "credit"
      ? this.balanceBefore + this.amount
      : this.balanceBefore - this.amount;

  if (
    !Number.isSafeInteger(expectedBalance) ||
    expectedBalance !== this.balanceAfter
  ) {
    throw new Error("Transaction balance calculation is incorrect.");
  }
});

module.exports = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);
