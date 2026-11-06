
const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true
    },

    currency: {
      type: String,
      enum: ["USDT"],
      default: "USDT",
      immutable: true
    },

    // 1 USDT = 1,000,000 micro-USDT.

    mainBalance: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Main wallet balance must be a safe integer."
      }
    },

    masterBalance: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Master wallet balance must be a safe integer."
      }
    },

    version: {
      type: Number,
      default: 0,
      min: 0
    },

    // Wallet operation lock.
    operationLockId: {
      type: String,
      default: null
    },

    operationLockAt: {
      type: Date,
      default: null
    },

    status: {
      type: String,
      enum: ["active", "locked"],
      default: "active",
      index: true
    }
  },
  {
    timestamps: true
  }
);

walletSchema.pre("validate", function () {
  if (
    !Number.isSafeInteger(this.mainBalance) ||
    !Number.isSafeInteger(this.masterBalance) ||
    this.mainBalance < 0 ||
    this.masterBalance < 0
  ) {
    throw new Error("Invalid wallet balance.");
  }
});

module.exports = mongoose.model("Wallet", walletSchema);
