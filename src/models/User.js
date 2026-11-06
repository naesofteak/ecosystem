
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // =====================================
    // MEMBER IDENTIFICATION
    // =====================================

    memberCode: {
      type: String,
      unique: true,
      required: true,
      trim: true
    },

    // =====================================
    // PERSONAL INFORMATION
    // =====================================

    name: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    mobile: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },

    // =====================================
    // AUTHENTICATION
    // =====================================

    passwordHash: {
      type: String,
      required: true,
      select: false
    },

    // =====================================
    // REFERRAL INFORMATION
    // =====================================

    // Unique referral code belonging to this member
    referralCode: {
      type: String,
      unique: true,
      required: true,
      trim: true
    },

    // Original member who referred this member
    sponsorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },

    // =====================================
    // BINARY TREE PLACEMENT
    // =====================================

    // Actual parent in the binary tree
    placementParentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    // Actual position under placement parent
    position: {
      type: String,
      enum: ["left", "right"],
      default: null
    },

    // Original side selected under the sponsor
    // This remains unchanged even when the member
    // is placed several levels below the sponsor.
    placementSide: {
      type: String,
      enum: ["left", "right"],
      default: null
    },

    // Direct left child in the binary tree
    leftChildId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    // Direct right child in the binary tree
    rightChildId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    // =====================================
    // USER ROLE
    // =====================================

    role: {
      type: String,
      enum: ["member", "admin", "superadmin"],
      default: "member"
    },

    // =====================================
    // ACCOUNT STATUS
    // =====================================

    status: {
      type: String,
      enum: [
        "pending_activation",
        "active",
        "suspended"
      ],
      default: "pending_activation",
      index: true
    },

    // =====================================
    // ACTIVATION INFORMATION
    // =====================================

    activation: {
      isActivated: {
        type: Boolean,
        default: false
      },

      activatedAt: {
        type: Date,
        default: null
      },

      // Provisional field.
      // Replace with integer micro-USDT or Decimal128
      // before implementing real financial transactions.
      activationFee: {
        type: Number,
        default: null
      },

      activationCurrency: {
        type: String,
        enum: ["USDT"],
        default: "USDT"
      },

      transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "WalletTransaction",
        default: null
      }
    },

    // =====================================
    // REGISTRATION DATE
    // =====================================

    joinedAt: {
      type: Date,
      default: Date.now
    }

  },
  {
    timestamps: true
  }
);


// =====================================
// BINARY PLACEMENT UNIQUE INDEX
// =====================================

// A parent can have only one left child
// and one right child.
//
// Root members with no placement parent
// are excluded from this index.

userSchema.index(
  {
    placementParentId: 1,
    position: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      placementParentId: { $type: "objectId" },
      position: { $type: "string" }
    }
  }
);


// =====================================
// ACTIVATION VALIDATION
// =====================================

userSchema.pre("validate", function () {

  const isActivated = this.activation?.isActivated === true;

  if (
    this.status === "active" &&
    !isActivated
  ) {
    throw new Error(
      "An active member must have completed activation."
    );
  }

  if (
    this.status === "pending_activation" &&
    isActivated
  ) {
    throw new Error(
      "A pending member cannot be marked as activated."
    );
  }

});


// =====================================
// EXPORT MODEL
// =====================================

module.exports = mongoose.model("User", userSchema);
