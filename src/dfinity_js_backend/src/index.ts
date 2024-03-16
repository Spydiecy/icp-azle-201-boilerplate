import { query, update, text, Record, StableBTreeMap, Variant, Vec, None, Some, Ok, Err, ic, Principal, Opt, nat64, Duration, Result, bool, Canister } from "azle";
import { Ledger, binaryAddressFromAddress, binaryAddressFromPrincipal, hexAddressFromPrincipal } from "azle/canisters/ledger";
import { hashCode } from "hashcode";
import { v4 as uuidv4 } from "uuid";

const LoanStatus = Variant({
    Active: text,
    Completed: text,
    Defaulted: text
});

const Loan = Record({
    id: text,
    amount: nat64,
    interestRate: nat64,
    duration: nat64,
    borrower: Principal,
    //lender: Principal,
    lender: Opt(Principal),
    status: LoanStatus,
    creationDate: nat64,
    dueDate: nat64
});

const LoanRequest = Record({
    amount: nat64,
    interestRate: nat64,
    duration: nat64
});

const UserProfile = Record({
    principal: Principal,
    name: text,
    balance: nat64
});

const Message = Variant({
    NotFound: text,
    InvalidPayload: text,
    PaymentFailed: text,
    PaymentCompleted: text
});
type Loan = {
    id: string;
    amount: bigint;
    interestRate: bigint;
    duration: bigint;
    borrower: Principal;
    lender: Principal;
    status: { Active?: string; Completed?: string; Defaulted?: string; }; // Adjust based on actual structure
    creationDate: bigint;
    dueDate: bigint;
};

interface LoanSummaryType {
    id: string;
    originalAmount: bigint;
    currentAmount: bigint;
    interestRate: bigint;
    duration: bigint;
    borrower: Principal;
    lender?: Principal;
    // status: string;
    status: string | undefined;
    creationDate: bigint;
    dueDate: bigint;
    accumulatedInterest: bigint;
}

const loansStorage = StableBTreeMap(0, text, Loan);
const loanRequestsStorage = StableBTreeMap(1, Principal, Vec(LoanRequest));
const userProfiles = StableBTreeMap(3, Principal, UserProfile);


export default Canister({
    registerUser: update([text], Result(text, Message), (name) => {
        const userProfile = {
            principal: ic.caller(),
            name: name,
            balance: 0n
        };

        userProfiles.insert(ic.caller(), userProfile);
        return Ok(`User ${name} registered successfully with principal ${ic.caller().toText()}`);
    }),

    saveFunds: update([nat64], Result(text, Message), async (amount) => {
        const userOpt = userProfiles.get(ic.caller());
        if ("None" in userOpt) {
            return Err({ NotFound: `User not found` });
        }

        const user = userOpt.Some;
        user.balance += amount;
        userProfiles.insert(user.principal, user);

        return Ok(`Amount ${amount} saved successfully.`);
    }),


    createLoanRequest: update([LoanRequest], Result(text, Message), (request) => {
        const loanRequestId = uuidv4();
        loanRequestsStorage.insert(ic.caller(), request);
        return Ok(loanRequestId);
    }),

    acceptLoanRequest: update([text], Result(Loan, Message), (loanRequestId) => {
        const requestOpt = loanRequestsStorage.get(loanRequestId);
        if ("None" in requestOpt) {
            return Err({ NotFound: `Loan request with id=${loanRequestId} not found` });
        }
    
        const request = requestOpt.Some;
        const loan = {
            id: uuidv4(),
            amount: request.amount,
            interestRate: request.interestRate,
            duration: request.duration,
            borrower: ic.caller(),
            lender: None, // Lender is not assigned yet
            status: { Active: "ACTIVE" },
            creationDate: ic.time(),
            dueDate: ic.time() + request.duration
        };
    
        loansStorage.insert(loan.id, loan);
        return Ok(loan);
    }),
    
    

    getLoanRequests: query([], Vec(LoanRequest), () => {
        return loanRequestsStorage.values();
    }),

    getLoans: query([], Vec(Loan), () => {
        return loansStorage.values();
    }),

    // Additional functions for loan management, repayments, and status updates



    makeRepayment: update([text, nat64], Result(text, Message), (loanId, repaymentAmount) => {
        const loanOpt = loansStorage.get(loanId);
        if ("None" in loanOpt) {
            return Err({ NotFound: `Loan with id=${loanId} not found` });
        }

        const loan = loanOpt.Some;
        // Logic to handle repayment.

        if (loanIsFullyRepaid(loan)) {
            loan.status = { Completed: "COMPLETED" };
            loansStorage.insert(loan.id, loan);
        }

        return Ok(`Repayment of ${repaymentAmount} for loan id=${loanId} successful`);
    }),
    getLoanStatus: query([text], Result(LoanStatus, Message), (loanId) => {
        const loanOpt = loansStorage.get(loanId);
        if ("None" in loanOpt) {
            return Err({ NotFound: `Loan with id=${loanId} not found` });
        }
        return Ok(loanOpt.Some.status);
    }),

    // Additional function to check for loan defaults
    checkForDefault: update([], Vec(text), () => {
        const defaultedLoans = loansStorage.values().filter(loan => loanIsDefaulted(loan));
        defaultedLoans.forEach(loan => {
            loan.status = { Defaulted: "DEFAULTED" };
            loansStorage.insert(loan.id, loan);
        });

        // Return an array of defaulted loan IDs
        return defaultedLoans.map(loan => loan.id);
    }),
    modifyLoanTerms: update([text, LoanRequest], Result(Loan, Message), (loanId, newTerms) => {
        const loanOpt = loansStorage.get(loanId);
        if ("None" in loanOpt) {
            return Err({ NotFound: `Loan with id=${loanId} not found` });
        }
    
        let loan = loanOpt.Some;
        if (loan.status.Active !== "ACTIVE") {
            return Err({ InvalidPayload: "Loan modification is only allowed for active loans." });
        }
    
        // Update loan terms
        loan.amount = newTerms.amount;
        loan.interestRate = newTerms.interestRate;
        loan.duration = newTerms.duration;
        loan.dueDate = calculateDueDate(newTerms.duration);
    
        loansStorage.insert(loan.id, loan);
        return Ok(loan);
    }),
    getUserLoanHistory: query([Principal], Vec(Loan), (userPrincipal) => {
        const userLoans = loansStorage.values().filter(loan =>
            loan.borrower.toText() === userPrincipal.toText() || 
            (loan.lender !== None && loan.lender.toText() === userPrincipal.toText())
        );
        return userLoans;
    }),
    accumulateInterest: update([], Vec(text), () => {
        const activeLoans = loansStorage.values().filter(loan => loan.status.Active === "ACTIVE");
        const updatedLoans: string[] = [];
    
        activeLoans.forEach(loan => {
            const accumulatedInterest = calculateAccumulatedInterest(loan);
            loan.amount += accumulatedInterest;
            loansStorage.insert(loan.id, loan);
            updatedLoans.push(loan.id);
        });
    
        return updatedLoans;
    }),
    
    
    
    automateLoanRepayment: update([], Vec(text), () => {
        const loansForRepayment = loansStorage.values().filter(loan => shouldAutomateRepayment(loan));
        const repaymentLoanIds: string[] = [];
    
        loansForRepayment.forEach(loan => {
            const repaymentAmount = calculateRepaymentAmount(loan);
            // Deduct from borrower's balance and update loan
            loan.amount -= repaymentAmount;
            loansStorage.insert(loan.id, loan);
            repaymentLoanIds.push(loan.id);
        });
    
        return repaymentLoanIds;
    }),
    requestLoanExtension: update([text, nat64], Result(Loan, Message), (loanId, newDuration) => {
        const loanOpt = loansStorage.get(loanId);
        if ("None" in loanOpt) {
            return Err({ NotFound: `Loan with id=${loanId} not found` });
        }
        let loan = loanOpt.Some;
        if (loan.status.Active !== "ACTIVE") {
            return Err({ InvalidPayload: "Loan extension is only allowed for active loans." });
        }
        // Ensure the new duration is longer than the current duration
        if (newDuration <= loan.duration) {
            return Err({ InvalidPayload: "New duration must be longer than the current duration." });
        }
        loan.duration = newDuration;
        loan.dueDate = calculateDueDate(newDuration);
        loansStorage.insert(loan.id, loan);
        return Ok(loan);
    }),
      
    
 
});

// function uuidv4(): text {
//     // UUID generation logic
//     return "uuid-placeholder";
// }
function calculateAccumulatedInterest(loan: Loan): bigint {
    // Example simple interest calculation
    const interest = loan.amount * loan.interestRate / 100n * (ic.time() - loan.creationDate) / (365n * 24n * 60n * 60n);
    return interest;
}



function shouldAutomateRepayment(loan: Loan): boolean {
    // Determine criteria for automated repayment
    return ic.time() >= loan.dueDate;
}

function calculateRepaymentAmount(loan: Loan): bigint {
    const accumulatedInterest = calculateAccumulatedInterest(loan);
    const partOfPrincipal = loan.amount / loan.duration;
    return accumulatedInterest + partOfPrincipal;
}


function calculateDueDate(duration: nat64): nat64 {
    // Logic to calculate the due date based on the loan duration
    return ic.time() + duration;
}


// Utility function to check if the loan is fully repaid
function loanIsFullyRepaid(loan: Loan): bool {
    // Implement logic to determine if the loan is fully repaid
    return false;
}

// Utility function to check for loan defaults
function loanIsDefaulted(loan: Loan): bool {
    // Implement logic to determine if the loan is defaulted based on due dates and repayments
    return false;
}

/*
    a hash function that is used to generate correlation ids for orders.
    also, we use that in the verifyPayment function where we check if the used has actually paid the order
*/
function hash(input: any): nat64 {
    return BigInt(Math.abs(hashCode().value(input)));
};

// a workaround to make uuid package work with Azle
globalThis.crypto = {
    // @ts-ignore
    getRandomValues: () => {
        let array = new Uint8Array(32);

        for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(Math.random() * 256);
        }

        return array;
    }
};