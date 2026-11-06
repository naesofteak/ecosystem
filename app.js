
const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");

require("dotenv").config();

const connectDB = require("./src/config/db");
const sessionConfig = require("./src/config/session");

const authRoutes = require("./src/modules/auth/auth.routes");
const memberRoutes = require("./src/modules/members/member.routes");

const app = express();


// =====================================
// VIEW ENGINE
// =====================================

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");


// =====================================
// GENERAL MIDDLEWARE
// =====================================

app.use(logger("dev"));

app.use(express.json());

app.use(express.urlencoded({
  extended: false
}));

app.use(cookieParser());

app.use(express.static(
  path.join(__dirname, "public")
));


// =====================================
// SESSION MIDDLEWARE
// =====================================

app.use(sessionConfig);


// =====================================
// APPLICATION ROUTES
// =====================================

// Authentication routes
app.use("/", authRoutes);

// Member routes
app.use("/", memberRoutes);


// =====================================
// PUBLIC HOME PAGE
// =====================================

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});


// =====================================
// 404 HANDLER
// =====================================

app.use((req, res, next) => {
  next(createError(404));
});


// =====================================
// GLOBAL ERROR HANDLER
// =====================================

app.use((err, req, res, next) => {

  console.error("APPLICATION ERROR:", err);

  res.locals.message = err.message;

  res.locals.error =
    req.app.get("env") === "development"
      ? err
      : {};

  res.status(err.status || 500);

  res.render("error");

});


// =====================================
// DATABASE CONNECTION
// =====================================

// Connect to database before accepting requests.

connectDB().catch((error) => {
  console.error("Database connection failed:", error);
  process.exit(1);
});


module.exports = app;
