
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env")
});

const mongoose = require("mongoose");
const assert = require("assert");
const crypto = require("crypto");

const User = require("../../src/models/User");

const Wallet = require("../../src/modules/wallets/wallet.model");
const WalletTransaction = require("../../src/modules/wallets/wallet-transaction.model");

const walletService = require("../../src/modules/wallets/wallet.service");

// --------------------------------------------------
// TEST CONFIGURATION
// --------------------------------------------------

const TEST_ID = crypto.randomBytes(5).toString("hex").toUpperCase();

const MICRO_USDT = walletService.MICRO_USDT;

let testUser = null;

let completedTests = 0;

function operationId(prefix) {
  return `${prefix}-${TEST_ID}-${crypto.randomUUID()}`;
}

function expectBalance(actual, expected, message) {
  assert.strictEqual(actual, expected, message);
}

function logPass(message) {
  completedTests++;
  console.log(`✅ PASS: ${message}`);
}

function logSection(message) {
  console.log(`\n---------------- ${message} ----------------`);
}

// --------------------------------------------------
// TEST MEMBER
// --------------------------------------------------

async function createTestMember() {
  testUser = await User.create({
    memberCode: `TEST${TEST_ID}`,
    name: "Wallet Test Member",
    email: `wallet-test-${TEST_ID.toLowerCase()}@example.com`,
    mobile: `9${Date.now().toString().slice(-9)}`,
    passwordHash: "test-password-hash",
    referralCode: `REF${TEST_ID}`,
    role: "member",
    status: "pending_activation",
    activation: {
      isActivated: false
    }
  });

  console.log("Test member created:", testUser.memberCode);

  return testUser;
}

// --------------------------------------------------
// READ WALLET
// --------------------------------------------------

async function readWallet() {
  const wallet = await Wallet.findOne({
    userId: testUser._id
  });

  assert.ok(wallet, "Wallet document should exist");

  return wallet;
}

// --------------------------------------------------
// TEST 1: CREATE WALLET
// --------------------------------------------------

async function testCreateWallet() {
  logSection("CREATE WALLET");

  await walletService.createWallet(testUser._id);

  const wallet = await readWallet();

  expectBalance(wallet.mainBalance, 0, "Main balance should start at zero");
  expectBalance(wallet.masterBalance, 0, "Master balance should start at zero");

  assert.strictEqual(wallet.currency, "USDT");

  logPass("Wallet created with zero USDT balances");
}

// --------------------------------------------------
// TEST 2: INCOME CREDIT - 60:40 SPLIT
// --------------------------------------------------

async function testIncomeCredit() {
  logSection("INCOME CREDIT - 60:40 SPLIT");

  await walletService.creditIncome({
    userId: testUser._id,
    amount: 100,
    category: "commission",
    operationId: operationId("COMMISSION"),
    description: "Wallet service test commission"
  });

  const wallet = await readWallet();

  expectBalance(
    wallet.mainBalance,
    60 * MICRO_USDT,
    "Main wallet should receive 60 USDT"
  );

  expectBalance(
    wallet.masterBalance,
    40 * MICRO_USDT,
    "Master wallet should receive 40 USDT"
  );

  logPass("100 USDT commission split into 60 USDT Main and 40 USDT Master");
}

// --------------------------------------------------
// TEST 3: DUPLICATE OPERATION
// --------------------------------------------------

async function testDuplicatePrevention() {
  logSection("DUPLICATE OPERATION");

  const id = operationId("DUPLICATE");

  const payload = {
    userId: testUser._id,
    amount: 20,
    category: "commission",
    operationId: id,
    description: "Duplicate prevention test"
  };

  await walletService.creditIncome(payload);

  const before = await readWallet();

  const duplicateResult = await walletService.creditIncome(payload);

  const after = await readWallet();

  expectBalance(
    after.mainBalance,
    before.mainBalance,
    "Duplicate must not change Main balance"
  );

  expectBalance(
    after.masterBalance,
    before.masterBalance,
    "Duplicate must not change Master balance"
  );

  assert.strictEqual(
    duplicateResult.duplicate,
    true,
    "Duplicate operation should be identified"
  );

  logPass("Duplicate operation did not credit the wallet twice");
}

// --------------------------------------------------
// TEST 4: MAIN WALLET DEBIT
// --------------------------------------------------

async function testMainWalletDebit() {
  logSection("MAIN WALLET DEBIT");

  const before = await readWallet();

  await walletService.debitWallet({
    userId: testUser._id,
    walletType: "main",
    amount: 10,
    category: "withdrawal",
    operationId: operationId("MAIN-DEBIT"),
    description: "Main wallet debit test"
  });

  const after = await readWallet();

  expectBalance(
    after.mainBalance,
    before.mainBalance - 10 * MICRO_USDT,
    "Main wallet debit should deduct 10 USDT"
  );

  logPass("Main wallet debit successful");
}

// --------------------------------------------------
// TEST 5: MASTER WALLET DEBIT
// --------------------------------------------------

async function testMasterWalletDebit() {
  logSection("MASTER WALLET DEBIT");

  const before = await readWallet();

  await walletService.debitWallet({
    userId: testUser._id,
    walletType: "master",
    amount: 5,
    category: "withdrawal",
    operationId: operationId("MASTER-DEBIT"),
    description: "Master wallet debit test"
  });

  const after = await readWallet();

  expectBalance(
    after.masterBalance,
    before.masterBalance - 5 * MICRO_USDT,
    "Master wallet debit should deduct 5 USDT"
  );

  logPass("Master wallet debit successful");
}

// --------------------------------------------------
// TEST 6: WALLET TRANSFER
// --------------------------------------------------

async function testWalletTransfer() {
  logSection("WALLET TRANSFER");

  const before = await readWallet();

  await walletService.transferWallet({
    userId: testUser._id,
    fromWallet: "main",
    toWallet: "master",
    amount: 10,
    operationId: operationId("TRANSFER"),
    description: "Main to Master transfer test"
  });

  const after = await readWallet();

  expectBalance(
    after.mainBalance,
    before.mainBalance - 10 * MICRO_USDT,
    "Main wallet should decrease by 10 USDT"
  );

  expectBalance(
    after.masterBalance,
    before.masterBalance + 10 * MICRO_USDT,
    "Master wallet should increase by 10 USDT"
  );

  logPass("10 USDT transferred from Main to Master");
}

// --------------------------------------------------
// TEST 7: INSUFFICIENT BALANCE
// --------------------------------------------------

async function testInsufficientBalance() {
  logSection("INSUFFICIENT BALANCE");

  const before = await readWallet();

  await assert.rejects(
    walletService.debitWallet({
      userId: testUser._id,
      walletType: "main",
      amount: 1000000,
      category: "withdrawal",
      operationId: operationId("INSUFFICIENT"),
      description: "Insufficient balance test"
    }),
    (error) => error.code === "INSUFFICIENT_BALANCE"
  );

  const after = await readWallet();

  expectBalance(
    after.mainBalance,
    before.mainBalance,
    "Failed debit must not change Main balance"
  );

  expectBalance(
    after.masterBalance,
    before.masterBalance,
    "Failed debit must not change Master balance"
  );

  logPass("Insufficient balance correctly rejected");
}

// --------------------------------------------------
// TEST 8: MICRO-USDT PRECISION
// --------------------------------------------------

async function testMicroUsdtPrecision() {
  logSection("MICRO-USDT PRECISION");

  const before = await readWallet();

  await walletService.creditIncome({
    userId: testUser._id,
    amount: 0.000001,
    category: "commission",
    operationId: operationId("MICRO"),
    description: "Micro USDT precision test"
  });

  const after = await readWallet();

  expectBalance(
    after.mainBalance,
    before.mainBalance + 1,
    "One micro-USDT should be credited to Main wallet"
  );

  expectBalance(
    after.masterBalance,
    before.masterBalance,
    "Master wallet should not receive a zero-value split"
  );

  logPass("Micro-USDT precision verified");
}

// --------------------------------------------------
// TEST 9: TRANSACTION HISTORY
// --------------------------------------------------

async function testTransactionHistory() {
  logSection("TRANSACTION HISTORY");

  const history = await walletService.getTransactions(
    testUser._id,
    1,
    100
  );

  assert.ok(history, "Transaction history should be returned");
  assert.ok(
    Array.isArray(history.transactions),
    "History should contain a transactions array"
  );

  assert.ok(
    history.transactions.length >= 7,
    "Expected at least seven wallet transaction entries"
  );

  logPass(
    `Transaction history returned ${history.transactions.length} entries`
  );
}

// --------------------------------------------------
// CLEANUP
// --------------------------------------------------

async function cleanup() {
  if (!testUser) return;

  console.log("\nCleaning up test records...");

  await WalletTransaction.deleteMany({
    userId: testUser._id
  });

  await Wallet.deleteMany({
    userId: testUser._id
  });

  await User.deleteOne({
    _id: testUser._id
  });

  console.log("Test records removed");
}

// --------------------------------------------------
// RUN TESTS
// --------------------------------------------------

async function runTests() {
  let testFailed = false;

  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is missing from your .env file");
    }

    if (!Number.isSafeInteger(MICRO_USDT) || MICRO_USDT <= 0) {
      throw new Error("Invalid MICRO_USDT export from wallet service");
    }

    console.log("\n========================================");
    console.log("       WALLET SERVICE TEST SUITE");
    console.log("========================================");

    await mongoose.connect(process.env.MONGODB_URI);

    console.log("MongoDB connected");

    await User.init();
    await Wallet.init();
    await WalletTransaction.init();

    await createTestMember();

    await testCreateWallet();
    await testIncomeCredit();
    await testDuplicatePrevention();
    await testMainWalletDebit();
    await testMasterWalletDebit();
    await testWalletTransfer();
    await testInsufficientBalance();
    await testMicroUsdtPrecision();
    await testTransactionHistory();

    console.log("\n========================================");
    console.log(`       ${completedTests} TESTS PASSED`);
    console.log("========================================");
  } catch (error) {
    testFailed = true;

    console.error("\n❌ WALLET TEST FAILED");
    console.error("Error:", error.message);
    console.error("Code:", error.code || "N/A");

    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      testFailed = true;
      console.error("Cleanup failed:", cleanupError.message);
    }

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (disconnectError) {
      testFailed = true;
      console.error("MongoDB disconnect failed:", disconnectError.message);
    }
  }

  if (testFailed) {
    process.exitCode = 1;
  }
}

runTests();
