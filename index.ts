require("dotenv").config();
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import admin from "firebase-admin";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { DecodedIdToken } from "firebase-admin/auth";

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3000;
const mongodbUri = process.env.MONGO_DB_URI;

if (!mongodbUri) {
  throw new Error("Missing MONGO_DB_URI env var.");
}

const client = new MongoClient(mongodbUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const firebaseServiceKeyB64 = process.env.FIREBASE_SERVICE_KEY;

if (!firebaseServiceKeyB64) {
  throw new Error(
    "Missing FIREBASE_SERVICE_KEY env var (base64-encoded service account JSON)."
  );
}
const serviceAccount = JSON.parse(
  Buffer.from(firebaseServiceKeyB64, "base64").toString("utf8")
);

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

declare global {
  namespace Express {
    interface Request {
      user?: DecodedIdToken;
    }
  }
}

/* ===============================
   Verify Firebase ID Token
================================ */
export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: "Forbidden" });
  }
};

/* ===============================
   Verify Email Match
================================ */
export const verifyEmail = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const email = req.query.email as string;

  if (!req.user || req.user.email !== email) {
    return res.status(403).json({ message: "Forbidden access" });
  }

  next();
};

async function run() {
  //   await client.connect();
  const database = client.db(process.env.DB_NAME);
  const usersCollection = database.collection("users");
  const activitiesCollection = database.collection("activities");

  try {
    const verifyAdmin = async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      const email = req?.query?.email as string;
      const user = await usersCollection.findOne({ email: email });
      if (!user || user?.role !== "admin") {
        return res
          .status(403)
          .json({ message: "only admins allowed", role: user?.role });
      }
      next();
    };

    //add or update user
    app.post("/user", verifyToken, async (req: Request, res: Response) => {
      const user = req.body;
      user.role = "user"; // Default role
      user.status = "active"; // Default status
      user.createdAt = new Date().toISOString();
      user.last_loggedIn = new Date().toISOString();
      console.log("User data received:", user);
      const query = { email: user.email };

      const alreadyExists = await usersCollection.findOne(query);
      if (!!alreadyExists) {
        const updateQuery = {
          $set: { last_loggedIn: new Date().toISOString() },
        };
        const activity = {
          userEmail: user.email,
          action: `${user?.name} Logged in`,
          createdAt: new Date().toISOString(),
        };
        const activityResult = await activitiesCollection.insertOne(activity);
        const result = await usersCollection.updateOne(query, updateQuery);
        return res.send({ message: "User logged in", result });
      }
      const activity = {
        userEmail: user.email,
        action: `${user?.name} created an account`,
        createdAt: new Date().toISOString(),
      };
      const activityResult = await activitiesCollection.insertOne(activity);
      const result = await usersCollection.insertOne(user);
      return res.send({ message: "User created Successfully", result });
    });
    //get user Profile
    app.get(
      "/user",
      verifyToken,
      verifyEmail,
      async (req: Request, res: Response) => {
        const email = req.query?.email as string;
        const query = { email: email };
        const user = await usersCollection.findOne(query);
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        user.daysActive = Math.floor(
          (new Date().getTime() - new Date(user.createdAt).getTime()) /
            (1000 * 60 * 60 * 24)
        );
        return res.send(user);
      }
    );

    //update user profile
    app.patch(
      "/user/profile",
      verifyToken,
      verifyEmail,
      async (req: Request, res: Response) => {
        const email = req.query.email as string;
        const updateData = req.body;
        const query = { email: email };
        const updateDoc = {
          $set: updateData,
        };
        const user = await usersCollection.findOne(query);
        const activity = {
          userEmail: email,
          action: `${user?.name} updated their profile`,
          createdAt: new Date().toISOString(),
        };
        const activityResult = await activitiesCollection.insertOne(activity);
        const result = await usersCollection.updateOne(query, updateDoc);
        return res.send({ message: "User profile updated", result });
      }
    );
    //get activities of a user
    app.get(
      "/user/activities",
      verifyToken,
      verifyEmail,
      async (req: Request, res: Response) => {
        const email = req.query?.email as string;
        const query = { userEmail: email };
        const activities = await activitiesCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        activities.forEach((activity) => {
          activity.timestamp = Math.floor(
            (new Date().getTime() - new Date(activity.createdAt).getTime()) /
              (1000 * 60 * 60 * 24)
          ); // in days
        });
        return res.send(activities);
      }
    );
    //get all users - admin only
    app.get(
      "/users",
      verifyToken,
      verifyAdmin,
      async (req: Request, res: Response) => {
        const users = await usersCollection.find().toArray();
        res.send(users);
      }
    );

    //get states for admin dashboard
    app.get(
      "/admin/stats",
      verifyToken,
      verifyAdmin,
      async (req: Request, res: Response) => {
        const usersCount = await usersCollection.countDocuments();
        const activeUsersCount = await usersCollection.countDocuments({
          status: "active",
        });
        const suspendedUsersCount = await usersCollection.countDocuments({
          status: "suspended",
        });
        const activitiesCount = await activitiesCollection.countDocuments({
          role: "admin",
        });
        const recentActivities = await activitiesCollection
          .find()
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        recentActivities.forEach((activity) => {
          activity.timestamp = Math.floor(
            (new Date().getTime() - new Date(activity.createdAt).getTime()) /
              (1000 * 60 * 60 * 24)
          ); // in days
        });
        return res.send({
          totalUsers: usersCount,
          activeUsers: activeUsersCount,
          suspendedUsers: suspendedUsersCount,
          recentActivities: activitiesCount,
          activities: recentActivities,
        });
      }
    );
    //role update by admin
    app.patch(
      "/user/role/:id",
      verifyToken,
      verifyAdmin,
      async (req: Request, res: Response) => {
        const id = req.params.id;
        const email = req.query.email as string;
        const { role } = req.body;

        const query = {
          _id: new ObjectId(id),
          email: { $ne: email },
          status: { $ne: "suspended" },
        }; // Prevent admin from changing their own role and changing role of suspended users
        const updateDoc = {
          $set: { role: role },
        };
        const result = await usersCollection.updateOne(query, updateDoc);
        const adminUser = await usersCollection.findOne({ email: email });
        const user = await usersCollection.findOne(query);
        const activity = {
          adminEmail: email,
          action: `${adminUser?.name} changed role of ${user?.name} to ${role}`,
          createdAt: new Date().toISOString(),
        };
        const activityResult = await activitiesCollection.insertOne(activity);
        return res.send({ message: "User role updated", result });
      }
    );
    //status update by admin
    app.patch(
      "/user/status/:id",
      verifyToken,
      verifyAdmin,
      async (req: Request, res: Response) => {
        const id = req.params.id;
        const email = req.query.email as string;
        const { status } = req.body;
        const query = { _id: new ObjectId(id), email: { $ne: email } }; // Prevent admin from changing their own status
        const updateDoc = {
          $set: { status: status },
        };
        const user = await usersCollection.findOne(query);
        const adminUser = await usersCollection.findOne({ email: email });
        const activity = {
          adminEmail: email,
          action: `${adminUser?.name} changed status of ${user?.name} to ${status}`,
          createdAt: new Date().toISOString(),
        };
        const activityResult = await activitiesCollection.insertOne(activity);
        const result = await usersCollection.updateOne(query, updateDoc);
        return res.send({ message: "User status updated", result });
      }
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req: Request, res: Response) => {
  res.send("Cyberpeers Server is running");
});

export default app;

if (!process.env.VERCEL && require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}
